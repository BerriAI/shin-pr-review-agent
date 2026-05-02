#!/usr/bin/env python3
"""
Isolated test: pattern agent using Anthropic SDK + simple tool loop (no pi SDK).

Usage:
    python scripts/test_pattern_loop.py <pr_url>
    python scripts/test_pattern_loop.py https://github.com/BerriAI/litellm/pull/26748
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from openai import OpenAI
from dotenv import load_dotenv

HERE = Path(__file__).parent
ROOT = HERE.parent

load_dotenv(ROOT / ".env")

LITELLM_API_BASE = os.environ["LITELLM_API_BASE"].rstrip("/")
LITELLM_API_KEY  = os.environ["LITELLM_API_KEY"]
MODEL            = os.environ.get("LITELLM_DEFAULT_MODEL", "anthropic/claude-sonnet-4-6")
GATHER_SCRIPT    = str(HERE / "gather_pattern_local.py")

# ── system prompt (mirrors TypeScript initSystemPrompts for pattern) ──────────

_PROSE_RULE = "plain prose, no markdown bold (`**` / `__`) or italics (`*x*` / `_x_`)"

_GROUNDING_RULE = """
GROUNDING (applies to every field below):
- State only what the gathered data shows. Never guess, never speculate.
- If a field the spec references is missing or null in the gather output,
  return the empty/null default for that schema field — do NOT invent one.
- Lists default to []. Optional scalars default to null.
"""

_PATTERN_OUTPUT_SCHEMA = f"""
OUTPUT OVERRIDE (supersedes the "Step 4" emit-prose section above):

Ignore the "emit overview / summary" instructions in that section. Do not
write prose. Return the PatternReport schema with these fields:
{_GROUNDING_RULE}
- findings: list of {{file, severity, risk, source, citation, rationale}}
  per the "Step 3: classify" rules above. Use severity blocker/suggestion/nit
  exactly as defined there. rationale max 200 chars, {_PROSE_RULE}.
- tech_debt: list of {{doc_path, code_path, note}} per the existing rule.
  note max 200 chars.

If there are no findings, return findings: []. If no tech_debt, return [].
Do not include overview or summary — Python composes the user-facing card
from your findings list downstream.
"""

_PATTERN_RISK_RUBRIC = r"""
RISK FIELD — for every finding, also set `risk` to one of high/medium/low
per the "Step 3.5" risk-assignment section of the SKILL above. Severity is
evidence strength; risk is BLAST RADIUS if you're right. They are
independent — a nit-severity finding can be high-risk and vice versa.

Assign risk by answering two questions about the worst-case behavior if
the finding is correct:

  1. Who is affected? users / operators / developers / nobody
  2. How does the bad state recover? unrecoverable / manual /
     self-healing / not-yet-deployed

Then look up the cell in this matrix:

| recovery \ affected | users  | operators | developers | nobody |
|---------------------|--------|-----------|------------|--------|
| unrecoverable       | high   | high      | medium     | low    |
| manual              | high   | medium    | medium     | low    |
| self-healing        | medium | low       | low        | low    |
| not-yet-deployed    | low    | low       | low        | low    |

State the (affected, recovery) pair in the rationale so a reviewer can
audit the call — e.g. "(users, self-healing) → medium" for a cache
format change, or "(users, manual) → high" for a removed import still
referenced in a handler.

When in doubt between two adjacent cells, pick the higher risk. A
false-positive costs the reviewer 30s; a false-negative ships a bug.
"""

_PATTERN_REJECTION_RULES = r"""
DEFAULT IS EMPTY. Most small focused PRs should produce findings: []. Only
emit a finding when the patch text shows a concrete deviation from a cited
doc or sibling — never to look thorough, never on truncated patches you
can't read.

REJECTION CHECKLIST — before emitting any finding, verify ALL of these
or drop the finding silently. The cost of one false positive is the
reviewer learning to ignore the agent on the next PR.

1. Rationale describes what the patch DOES (visible in patch text), not
   what it MIGHT do. Reject finding if rationale contains: "may", "might",
   "could", "risks", "if never populated", "potentially", "unverifiable",
   "cannot be verified", "if X happens".
2. Rationale does NOT mention truncation or unreadable patches. Reject
   if it contains: "patch is truncated", "truncated patch", "cannot
   verify", "can't verify", "not visible in this patch". If you can't
   read the change, you cannot make a finding about it.
3. Conforms files emit nothing. Files classified `conforms` or
   `no_pattern_found` in the "Step 3" classification produce zero findings.

Must-flag triggers (the "Step 3.5" / SKILL hard-rules section) are NOT
speculative — they describe shapes visible in the patch text. Apply them
when the patch literally contains them: gated public-route imports,
ERROR-METADATA fields (error_message / error_msg / error_information /
exception_str / failure_reason — NOT general response/content fields) set
to None/empty in non-test code, removal of an import still referenced in
the diff, removal of public config defaults. These emit risk=high.
"""

PATTERN_OUTPUT_OVERRIDE = _PATTERN_OUTPUT_SCHEMA + _PATTERN_RISK_RUBRIC + _PATTERN_REJECTION_RULES


def build_system_prompt() -> str:
    pattern_md = (ROOT / "skills" / "pattern.md").read_text()
    path_redirect = (
        f"TOOL USE: Wherever the instructions below say to run "
        f"`python ${{CLAUDE_SKILL_DIR}}/scripts/gather_pattern_data.py <ref>`, "
        f"instead run `python {GATHER_SCRIPT} <ref>` via bash. "
        f"It returns the same JSON shape the script would have printed.\n\n"
    )
    return (
        path_redirect
        + pattern_md
        + "\n\n"
        + PATTERN_OUTPUT_OVERRIDE
        + "\n\nPrint your JSON on the LAST LINE of your response. Single-line JSON only."
    )


# ── bash tool ─────────────────────────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a bash command and return stdout+stderr.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute."}
                },
                "required": ["command"],
            },
        },
    }
]


def run_bash(command: str) -> str:
    print(f"    [bash cmd ] {command[:160]}")
    t0 = time.time()
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=180,
        env={
            **os.environ,
            "LITELLM_API_BASE": LITELLM_API_BASE,
            "LITELLM_API_KEY": LITELLM_API_KEY,
        },
    )
    MAX_TOOL_OUTPUT = 25_000
    elapsed = time.time() - t0
    output = (result.stdout + result.stderr).strip()
    print(f"    [bash done] {elapsed:.1f}s  exit={result.returncode}  {len(output)} chars out")
    if output:
        preview = output[:200].replace("\n", " ")
        print(f"    [bash out ] {preview}{'…' if len(output) > 200 else ''}")
    if len(output) > MAX_TOOL_OUTPUT:
        output = output[:MAX_TOOL_OUTPUT] + "\n... [output truncated]"
        print(f"    [bash trunc] capped at {MAX_TOOL_OUTPUT} chars")
    return output or "(no output)"


# ── agent loop (OpenAI SDK → LiteLLM /v1/chat/completions) ───────────────────

def run_pattern_agent(pr_url: str) -> tuple[str, float, int]:
    """Returns (output_text, elapsed_seconds, num_turns)."""
    client = OpenAI(
        base_url=f"{LITELLM_API_BASE}/v1",
        api_key=LITELLM_API_KEY,
    )

    system  = build_system_prompt()
    messages: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user",   "content": f"Review this PR for pattern conformance: {pr_url}"},
    ]

    t0   = time.time()
    turn = 0

    while True:
        turn += 1
        input_chars = sum(
            len(m.get("content") or "")
            if isinstance(m.get("content"), str)
            else sum(len(str(p)) for p in (m.get("content") or []))
            for m in messages
        )
        print(f"\n┌─ turn {turn}  messages={len(messages)}  ~{input_chars} context chars")

        t_req = time.time()
        response = client.chat.completions.create(
            model=MODEL,
            max_tokens=8192,
            tools=TOOLS,
            tool_choice="auto",
            messages=messages,
        )
        t_resp = time.time() - t_req

        choice  = response.choices[0]
        msg     = choice.message
        finish  = choice.finish_reason
        n_tools = len(msg.tool_calls or [])
        print(f"└─ {t_resp:.1f}s  finish={finish}  tool_calls={n_tools}")

        # append assistant turn (preserving tool_calls for context)
        # Convert Pydantic object to dict so later messages can call .get()
        assistant_dict: dict = {"role": msg.role, "content": msg.content}
        if msg.tool_calls:
            assistant_dict["tool_calls"] = [
                {"id": tc.id, "type": tc.type,
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ]
        messages.append(assistant_dict)

        if finish == "stop" or (finish != "tool_calls" and not msg.tool_calls):
            text    = msg.content or ""
            elapsed = time.time() - t0
            print(f"\n✓ done  {elapsed:.1f}s total  {turn} turns")
            return text, elapsed, turn

        # execute tool calls
        for tc in (msg.tool_calls or []):
            fn   = tc.function
            args = json.loads(fn.arguments)
            print(f"  ├ tool_call  name={fn.name}  id={tc.id}")

            if fn.name == "bash":
                result_text = run_bash(args.get("command", ""))
            else:
                result_text = f"Unknown tool: {fn.name}"
                print(f"  └ UNKNOWN TOOL: {fn.name}")

            messages.append({
                "role":         "tool",
                "tool_call_id": tc.id,
                "content":      result_text,
            })


# ── main ──────────────────────────────────────────────────────────────────────

def _extract_json(text: str) -> dict | None:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    return None


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python scripts/test_pattern_loop.py <pr_url>")
        sys.exit(1)

    pr_url = sys.argv[1]

    print("=" * 60)
    print(f"Pattern agent  —  simple tool loop (no pi SDK)")
    print(f"PR:    {pr_url}")
    print(f"Model: {MODEL}")
    print(f"Base:  {LITELLM_API_BASE}")
    print("=" * 60)

    t_wall_start = time.time()
    output, elapsed, turns = run_pattern_agent(pr_url)
    t_wall = time.time() - t_wall_start

    print("\n" + "=" * 60)
    print("OUTPUT (last 3000 chars):")
    print("=" * 60)
    print(output[-3000:] if len(output) > 3000 else output)

    print("\n" + "=" * 60)
    print("BENCHMARK")
    print("=" * 60)
    print(f"Wall time : {t_wall:.1f}s")
    print(f"Agent time: {elapsed:.1f}s")
    print(f"Turns     : {turns}")

    data = _extract_json(output)
    if data is not None:
        findings  = data.get("findings", [])
        tech_debt = data.get("tech_debt", [])
        print(f"JSON OK   : findings={len(findings)}  tech_debt={len(tech_debt)}")
        if findings:
            print("Findings:")
            for f in findings:
                print(f"  [{f.get('severity','?')} risk={f.get('risk','?')}] {f.get('file','?')} — {f.get('rationale','')[:80]}")
    else:
        print("JSON      : NOT FOUND in output — model returned prose")


if __name__ == "__main__":
    main()
