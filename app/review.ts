import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import * as db from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../skills");
const GATHER_SCRIPT = resolve(__dirname, "../scripts/gather_pr_triage_data.py");
const PATTERN_GATHER_SCRIPT = resolve(
  __dirname,
  "../scripts/gather_pattern_local.py",
);

// --- Pi SDK shared infra (initialised once) -----------------------------------

export let authStorage!: AuthStorage;
export let modelRegistry!: ModelRegistry;

export async function initRegistry(): Promise<void> {
  authStorage = AuthStorage.create();
  modelRegistry = ModelRegistry.create(authStorage);

  const base = process.env.LITELLM_API_BASE?.replace(/\/+$/, "");
  const key = process.env.LITELLM_API_KEY;
  if (!base || !key) {
    return;
  }

  const CHAT_MODEL_DROP = [
    "dall-e",
    "sora",
    "whisper",
    "tts",
    "embedding",
    "moderation",
    "realtime",
    "image",
    "audio",
    "transcribe",
    "search-preview",
    "search-api",
    "deep-research",
    "1024-x-",
    "1536-x-",
    "1792-x-",
    "512-x-",
    "256-x-",
    "davinci-",
    "babbage-",
    "-instruct",
    "chatgpt-image",
  ];
  function isChatModel(id: string): boolean {
    if (id.endsWith("/*")) return false;
    const lower = id.toLowerCase();
    return !CHAT_MODEL_DROP.some((bad) => lower.includes(bad));
  }

  let modelIds: string[] = [];
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const payload = (await r.json()) as { data?: Array<{ id: string }> };
    modelIds = (payload.data ?? []).map((m) => m.id).filter(isChatModel);
  } catch {
    modelIds = ["openai/gpt-4o-mini"];
  }
  if (!modelIds.length) {
    return;
  }

  modelRegistry.registerProvider("litellm", {
    name: "LiteLLM",
    baseUrl: `${base}/v1`,
    apiKey: "LITELLM_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    })),
  });

  const preferred =
    process.env.LITELLM_DEFAULT_MODEL ||
    modelIds.find((id) => id === "anthropic/claude-sonnet-4-6") ||
    modelIds.find((id) => id.startsWith("anthropic/claude-sonnet")) ||
    modelIds.find((id) => id.startsWith("anthropic/claude")) ||
    modelIds.find((id) => id.startsWith("openai/gpt-4")) ||
    modelIds[0];
  defaultModelId = preferred;
  _litellmBase = base;
  _litellmKey = key;
}

let defaultModelId: string | undefined;
let _litellmBase: string | undefined;
let _litellmKey: string | undefined;

function defaultModel() {
  if (!defaultModelId) return undefined;
  return modelRegistry.find("litellm", defaultModelId);
}

// --- runPrompt helper ----------------------------------------------------------

type ToolTraceEntry =
  | { kind: "call"; tool: string; args: unknown }
  | { kind: "result"; tool: string; isError: boolean; preview: string };

export type StreamEvent =
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; isError: boolean; preview: string }
  | { type: "text_delta"; delta: string }
  | { type: "progress"; text: string };

export async function runPrompt(
  session: AgentSession,
  message: string,
  onStream?: (event: StreamEvent) => void,
): Promise<{ output: string; toolTrace: ToolTraceEntry[] }> {
  const trace: ToolTraceEntry[] = [];
  let assistantText = "";
  const pending = new Map<string, string>();
  let settled = false;
  let release!: () => void;
  const done = new Promise<void>((res) => {
    release = res;
  });

  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update") {
      const m = event.assistantMessageEvent;
      if (m?.type === "text_delta" && typeof m.delta === "string") {
        assistantText += m.delta;
        onStream?.({ type: "text_delta", delta: m.delta });
      }
    } else if (event.type === "tool_execution_start") {
      const id = event.toolCallId ?? `${event.toolName}:${trace.length}`;
      pending.set(id, event.toolName);
      trace.push({
        kind: "call",
        tool: event.toolName,
        args: event.args ?? {},
      });
      onStream?.({
        type: "tool_call",
        tool: event.toolName,
        args: event.args ?? {},
      });
    } else if (event.type === "tool_execution_end") {
      const id = event.toolCallId ?? "";
      const name = pending.get(id) ?? event.toolName ?? "tool";
      pending.delete(id);
      const raw = event.result ?? event.output ?? event.error ?? "";
      const s = typeof raw === "string" ? raw : JSON.stringify(raw);
      const preview = s.length > 240 ? s.slice(0, 240) + "…" : s;
      trace.push({
        kind: "result",
        tool: name,
        isError: !!event.isError,
        preview,
      });
      onStream?.({
        type: "tool_result",
        tool: name,
        isError: !!event.isError,
        preview,
      });
    } else if (event.type === "tool_execution_update") {
      const raw = event.update;
      const text =
        raw == null ? "" :
        typeof raw === "string" ? raw :
        JSON.stringify(raw);
      if (text) onStream?.({ type: "progress", text });
    } else if (event.type === "agent_end" && !settled) {
      settled = true;
      release();
    }
  });

  try {
    await session.prompt(message);
    await done;
  } finally {
    unsubscribe();
  }

  if (!assistantText.trim()) {
    const msgs: any[] =
      (session as any).messages ??
      (session as any).agent?.state?.messages ??
      [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === "assistant") {
        const c = m.content;
        if (typeof c === "string") {
          assistantText = c;
        } else if (Array.isArray(c)) {
          assistantText = c
            .filter((p: any) => p?.type === "text")
            .map((p: any) => p.text)
            .join("");
        }
        break;
      }
    }
  }

  return { output: assistantText, toolTrace: trace };
}

// --- System prompts -----------------------------------------------------------

function loadSkill(name: string): string {
  return readFileSync(`${SKILLS_DIR}/${name}`, "utf8");
}

// pathRedirect: tells the agent to invoke a concrete script path instead of the
// placeholder `$CLAUDE_SKILL_DIR/scripts/<name>` reference in the upstream SKILL.md.
// Matches the Python _redirect() function in app.py exactly.
function pathRedirect(scriptName: string, scriptPath: string): string {
  return (
    `TOOL USE: Wherever the instructions below say to run ` +
    `\`python \${CLAUDE_SKILL_DIR}/scripts/${scriptName} <ref>\`, ` +
    `instead run \`python ${scriptPath} <ref>\` via bash. ` +
    `It returns the same JSON shape the script would have printed.\n\n`
  );
}

// The following override strings are verbatim ports of the Python constants
// TRIAGE_OUTPUT_OVERRIDE and PATTERN_OUTPUT_OVERRIDE from app.py.
// They are inlined here (rather than read at runtime) so this module has no
// runtime dependency on the Python source file.

const _PROSE_RULE =
  "plain prose, no markdown bold (`**` / `__`) or italics (`*x*` / `_x_`)";

const _GROUNDING_RULE = `
GROUNDING (applies to every field below):
- State only what the gathered data shows. Never guess, never speculate.
- If a field the spec references is missing or null in the gather output,
  return the empty/null default for that schema field — do NOT invent one.
- Lists default to []. Optional scalars default to null.
`;

const TRIAGE_OUTPUT_OVERRIDE = `
OUTPUT OVERRIDE (supersedes the "Step 6: write the verdict" section above):

Ignore the "write the verdict" instructions in that section. Do not emit
prose with overview / summary / details / file_callouts. Instead, return
the TriageReport schema with these fields:
${_GROUNDING_RULE}
- pr_number, pr_title, pr_author: from the gathered data.
- pr_summary: ONE paragraph (max 600 chars), ${_PROSE_RULE}.
  Describe what the PR changes (infer from pr_title + diff_files).
  Target voice — concrete, load-bearing, no marketing tone. Example:
    "Adds a \`--retries\` flag to the CLI so transient 5xx responses retry
     up to N times with exponential backoff; touches cli.py and
     http_client.py; default behavior unchanged when the flag is omitted."
- files_changed, additions, deletions: leave at the schema default (0).
  Python recomputes these deterministically from the gather output post-run
  — anything you put here is overwritten, so don't waste reasoning on sums.
- pr_related_failures: list of check names from failing_check_contexts where
  the "Step 2: classify each failing check" rules above set
  related_to_pr_diff=True AND is_policy_meta is False.
- unrelated_failures: list of check names where related_to_pr_diff is False
  AND is_policy_meta is False.
- unrelated_failures_also_failing_elsewhere: SUBSET of unrelated_failures.
  Algorithm:
    for name in unrelated_failures:
      include name iff failing_check_contexts[name].also_failing_on_other_prs
      is True (already pre-derived by the gather script — copy it, do NOT
      recompute from other_prs[*].conclusion).
  Result MUST be a subset of unrelated_failures; the rubric depends on it.
- policy_meta_failures: list of check names where is_policy_meta is True.
  These are NEVER in pr_related_failures or unrelated_failures — separate
  bucket. The rubric ignores them; surface them so the contributor knows
  to fix (rebase, sign CLA, etc.) but not as a merge-confidence penalty.
- failure_rationales: dict keyed by check_name, value is one short sentence
  (≤180 chars, ${_PROSE_RULE}) explaining WHY that check landed in its
  bucket. Required for every name in pr_related_failures, unrelated_failures,
  and policy_meta_failures — the drilldown shows it next to the check name
  so the reviewer can audit the classification without clicking through to
  GitHub. Ground each rationale in the gathered data:
    - PR-related: cite a file/symbol from \`failure_excerpt\` or \`annotations\`
      that overlaps \`diff_files\` (e.g. "Annotation points at
      litellm/proxy/auth.py which is in this diff."). For the
      uninformative-log path, say so explicitly (e.g. "No log hint, but
      check passes on every sampled neighbor PR — failing only here.").
    - unrelated: cite the infra/cross-PR signal (e.g. "Same check failing
      on PRs #26385 and #26011 — broken-for-everyone infra." or "Log shows
      a docker pull rate-limit, no overlap with diff files.").
    - policy_meta: name the policy (e.g. "DCO sign-off missing on the most
      recent commit." or "PR opened from main; repo policy requires a
      feature branch.").
  Use ONLY signals visible in the gathered data — never speculate. If the
  data is too thin to ground a rationale, return the empty string for that
  key (the drilldown will skip the explanation rather than fabricate one).
- running_checks: in_progress_checks verbatim.
- greptile_score: the int from the gathered data, or null.
- has_circleci_checks: bool from the gathered data.
- has_merge_conflicts: tri-state bool. Set to true iff the gathered data has
  \`mergeable\` == false OR \`mergeable_state\` == "dirty". Set to false iff
  \`mergeable\` == true AND \`mergeable_state\` is one of "clean"/"unstable"/
  "has_hooks". Set to null iff \`mergeable\` is null (GitHub still computing) or
  \`mergeable_state\` is "unknown" — never guess.
- scope_drift: bool. Set per SKILL.md Step 6 by comparing \`diff_files\` against
  every entry in \`linked_issues\`. Set true when:
    (a) the diff touches files/concerns the linked issue's title+body does
        NOT mention AND the diff is materially broader than the issue
        describes (over-reach), OR
    (b) the diff is narrower than the linked issue's stated bug class —
        e.g. issue title says "non-chat endpoints" plural but diff only
        fixes one mode (under-reach / narrow guard).
  Set false when \`linked_issues\` is empty (intent unverified, but no drift
  to flag — the missing-issue note goes in the verdict prose, not here),
  or when the diff matches the issue's scope.
- scope_drift_reason: ONE sentence (≤280 chars, ${_PROSE_RULE}) citing the
  specific linked-issue field (title or body excerpt) that conflicts with
  the diff. REQUIRED when scope_drift is true, validator rejects the empty
  string. Empty string when scope_drift is false. Quote the issue text
  verbatim where you can — the reviewer audits this.
- prior_signals: list of {source, excerpt, severity, status, reason} per
  SKILL.md Step 5.5. One entry per \`pr_review_comments\` entry, plus ONE
  entry for the Greptile body when \`greptile_review_body\` is non-empty
  (treat the body as a single signal even if it makes multiple sub-points
  — break it apart only if the body explicitly enumerates separate
  numbered items). Fields:
    - source: "greptile" for the Greptile body, or the comment author's
      login verbatim (copy from \`pr_review_comments[*].author\`).
    - excerpt: ≤200 chars, the exact phrase the comment turns on. Quote
      verbatim from the gather data — never paraphrase.
    - severity: "nit" | "concern" | "blocker" per Step 5.5 rules. The
      keyword guardrail is mandatory: comment text containing "breaks",
      "fails", "wrong", "users", "production", "data loss", "security",
      "regression", "404", "500", "crash", or "silently" CANNOT be
      classified as "nit".
    - status: "agreed" | "resolved" | "disagreed" | "out_of_scope".
    - reason: REQUIRED when status is "disagreed" or "out_of_scope".
      Empty when status is "agreed" or "resolved". Validator rejects
      dismissals without justification — the rubric treats those as
      "agreed".
  Empty list when both \`greptile_review_body\` is empty AND
  \`pr_review_comments\` is empty. The rubric handles the empty case
  (no penalty fires).

Worked example (illustrative shape only — your values come from the gather
output, not from this template):
{
  "pr_number": 26451,
  "pr_title": "fix: handle null tool_calls in streaming response",
  "pr_author": "ishaan-jaff",
  "pr_summary": "Guards the streaming response handler against a null tool_calls field that newer OpenAI responses can return; without the guard the handler raises AttributeError and the stream silently drops. No behavior change when tool_calls is present.",
  "files_changed": 0,
  "additions": 0,
  "deletions": 0,
  "pr_related_failures": ["code-quality"],
  "unrelated_failures": ["lint", "codecov/patch"],
  "unrelated_failures_also_failing_elsewhere": ["lint"],
  "policy_meta_failures": [],
  "failure_rationales": {
    "code-quality": "Annotation flags an unused import in litellm/llms/openai/streaming_handler.py which this PR edits.",
    "lint": "Same lint suite is failing on PRs #26385 and #26011 — broken-for-everyone infra.",
    "codecov/patch": "PR adds zero testable production lines (guard-only patch); codecov/patch fails by definition here."
  },
  "running_checks": [],
  "greptile_score": 4,
  "has_circleci_checks": true,
  "has_merge_conflicts": false,
  "scope_drift": true,
  "scope_drift_reason": "Linked issue #26406 title says 'non-chat endpoints' (plural — embedding/audio/video/rerank); diff only guards image_generation, leaving the other modes unfixed.",
  "prior_signals": [
    {
      "source": "greptile",
      "excerpt": "Confidence Score: 4/5 — fix is correct and well-tested; only image_generation is guarded.",
      "severity": "concern",
      "status": "agreed",
      "reason": ""
    },
    {
      "source": "krrish-berri-2",
      "excerpt": "this feels like a much broader fix for the issue, instead of just filtering access groups",
      "severity": "concern",
      "status": "agreed",
      "reason": ""
    }
  ]
}

Do not include any prose justification, summary, or details — Python composes
those from these structured fields downstream. Your job ends at field-filling.
`;

const _PATTERN_OUTPUT_SCHEMA = `
OUTPUT OVERRIDE (supersedes the "Step 4" emit-prose section above):

Ignore the "emit overview / summary" instructions in that section. Do not
write prose. Return the PatternReport schema with these fields:
${_GROUNDING_RULE}
- findings: list of {file, severity, risk, source, citation, rationale}
  per the "Step 3: classify" rules above. Use severity blocker/suggestion/nit
  exactly as defined there. rationale max 200 chars, ${_PROSE_RULE}.
- tech_debt: list of {doc_path, code_path, note} per the existing rule.
  note max 200 chars.

If there are no findings, return findings: []. If no tech_debt, return [].
Do not include overview or summary — Python composes the user-facing card
from your findings list downstream.
`;

const _PATTERN_RISK_RUBRIC = `
RISK FIELD — for every finding, also set \`risk\` to one of high/medium/low
per the "Step 3.5" risk-assignment section of the SKILL above. Severity is
evidence strength; risk is BLAST RADIUS if you're right. They are
independent — a nit-severity finding can be high-risk and vice versa.

Assign risk by answering two questions about the worst-case behavior if
the finding is correct:

  1. Who is affected? users / operators / developers / nobody
  2. How does the bad state recover? unrecoverable / manual /
     self-healing / not-yet-deployed

Then look up the cell in this matrix:

| recovery \\ affected | users  | operators | developers | nobody |
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
`;

const _PATTERN_REJECTION_RULES = `
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
3. Conforms files emit nothing. Files classified \`conforms\` or
   \`no_pattern_found\` in the "Step 3" classification produce zero findings.

Must-flag triggers (the "Step 3.5" / SKILL hard-rules section) are NOT
speculative — they describe shapes visible in the patch text. Apply them
when the patch literally contains them: gated public-route imports,
ERROR-METADATA fields (error_message / error_msg / error_information /
exception_str / failure_reason — NOT general response/content fields) set
to None/empty in non-test code, removal of an import still referenced in
the diff, removal of public config defaults. These emit risk=high.
`;

const PATTERN_OUTPUT_OVERRIDE =
  _PATTERN_OUTPUT_SCHEMA + _PATTERN_RISK_RUBRIC + _PATTERN_REJECTION_RULES;

// --- System prompt assembly ---------------------------------------------------

let TRIAGE_SYSTEM: string;
let PATTERN_SYSTEM: string;
let KARPATHY_SYSTEM: string;
let CHAT_SYSTEM: string;
let PATTERN_SYSTEM_SINGLE_SHOT: string;

export function initSystemPrompts(): void {
  const triageSkill = loadSkill("triage.md");
  const patternSkill = loadSkill("pattern.md");
  const karpathySkill = loadSkill("karpathy.md");

  TRIAGE_SYSTEM =
    pathRedirect("gather_pr_triage_data.py", GATHER_SCRIPT) +
    triageSkill +
    "\n\n" +
    TRIAGE_OUTPUT_OVERRIDE;

  PATTERN_SYSTEM =
    pathRedirect("gather_pattern_data.py", PATTERN_GATHER_SCRIPT) +
    patternSkill +
    "\n\n" +
    PATTERN_OUTPUT_OVERRIDE;

  PATTERN_SYSTEM_SINGLE_SHOT =
    "All context is pre-loaded below — do NOT call any tool or run bash. " +
    "Analyze only what is provided in this prompt.\n\n" +
    patternSkill +
    "\n\n" +
    PATTERN_OUTPUT_OVERRIDE +
    "\n\nPrint your JSON on the LAST LINE of your response. Single-line JSON only.";

  KARPATHY_SYSTEM = karpathySkill;

  CHAT_SYSTEM =
    "You are a helpful PR review assistant for the BerriAI/litellm repository. " +
    "When the user asks you to review a PR or pastes a GitHub PR URL, call the `review_pr` tool with the URL. " +
    "The tool runs the full triage + pattern pipeline and returns a merge confidence card and drilldown. " +
    "Present the results clearly. For follow-up questions or general discussion, answer directly.";
}

// --- Zod schemas (mirrors Python Pydantic models) ----------------------------

const PriorSignalSchema = z.object({
  source: z.string(),
  excerpt: z.string().max(200),
  severity: z.enum(["nit", "concern", "blocker"]),
  status: z.enum(["agreed", "resolved", "disagreed", "out_of_scope"]),
  reason: z.string().default(""),
});

export const TriageReportSchema = z.object({
  pr_number: z.number().int(),
  pr_title: z.string(),
  pr_author: z.string(),
  pr_summary: z.string().max(600),
  files_changed: z.number().int().default(0),
  additions: z.number().int().default(0),
  deletions: z.number().int().default(0),
  pr_related_failures: z.array(z.string()).default([]),
  unrelated_failures: z.array(z.string()).default([]),
  unrelated_failures_also_failing_elsewhere: z.array(z.string()).default([]),
  policy_meta_failures: z.array(z.string()).default([]),
  failure_rationales: z.record(z.string()).default({}),
  running_checks: z.array(z.string()).default([]),
  greptile_score: z.number().int().nullable().default(null),
  has_circleci_checks: z.boolean(),
  has_merge_conflicts: z.boolean().nullable().default(null),
  scope_drift: z.boolean().default(false),
  scope_drift_reason: z.string().max(300).default(""),
  prior_signals: z.array(PriorSignalSchema).default([]),
});
export type TriageReport = z.infer<typeof TriageReportSchema>;

const PatternFindingSchema = z.object({
  file: z.string(),
  severity: z.enum(["blocker", "suggestion", "nit"]),
  risk: z.enum(["high", "medium", "low"]).default("low"),
  source: z.enum(["docs", "code"]),
  citation: z.string(),
  rationale: z.string().max(400),
});

const TechDebtItemSchema = z.object({
  doc_path: z.string(),
  code_path: z.string(),
  note: z.string().max(200),
});

export const PatternReportSchema = z.object({
  findings: z.array(PatternFindingSchema).default([]),
  tech_debt: z.array(TechDebtItemSchema).default([]),
});
export type PatternReport = z.infer<typeof PatternReportSchema>;

// --- Security agent schemas ---------------------------------------------------

const SecurityFindingSchema = z.object({
  file: z.string().default(""),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).default("info"),
  vulnerability_type: z.string().default(""),
  description: z.string().default(""),
  recommendation: z.string().default(""),
});

export const SecurityReportSchema = z.object({
  findings: z.array(SecurityFindingSchema).default([]),
  summary: z.string().default(""),
  overall_risk: z.enum(["critical", "high", "medium", "low", "none"]).default("none"),
});
export type SecurityReport = z.infer<typeof SecurityReportSchema>;

const KarpathyFindingSchema = z.object({
  regression_archetype: z.string().default(""),
  bug_class: z.string().default(""),
  fix_locus: z.string().default(""),
  sibling_loci: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  breadth: z.enum([
    "narrow_correct",
    "narrow_missed_class",
    "scope_expansion",
    "scope_drift",
    "wrong_fix_layer",
    "performance_regression_hot_path",
    "dead_code_unreachable",
    "production_behavior_mismatch",
    "maintainability_risk",
    "behavior_change_high_blast_radius",
  ]),
  recommended_fix: z.string().default(""),
});

const KarpathyMergeGateSchema = z.object({
  safe_for_high_rps_gateway: z
    .enum(["yes", "no", "conditional"])
    .default("yes"),
  one_liner: z.string().default(""),
  unintended_consequences: z.array(z.string()).default([]),
  hot_path_notes: z.array(z.string()).default([]),
  what_would_make_yes: z.string().default(""),
});

export const KarpathyReviewSchema = z.object({
  linked_issue: z.string().nullable().default(null),
  fix_shapes: z.array(z.string()).default([]),
  merge_gate: KarpathyMergeGateSchema.default({}),
  findings: z.array(KarpathyFindingSchema).default([]),
});
export type KarpathyReview = z.infer<typeof KarpathyReviewSchema>;

// --- JSON extraction (last-line JSON from agent text) -------------------------

function extractLastJson(text: string): unknown | null {
  const lines = text.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("{")) {
      try {
        return JSON.parse(t);
      } catch {
        /* continue */
      }
    }
  }
  // Fallback: find any {...} block
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* */
    }
  }
  return null;
}

// --- review_pr tool (exposed to chat agent) -----------------------------------

const reviewPrTool = defineTool({
  name: "review_pr",
  label: "Review PR",
  description:
    "Run the full triage + pattern review pipeline on a GitHub PR URL. Returns a merge confidence card and drilldown with CI analysis, pattern conformance findings, and prior reviewer signals.",
  parameters: {
    type: "object" as const,
    required: ["pr_url"],
    properties: {
      pr_url: {
        type: "string",
        description:
          "GitHub pull request URL, e.g. https://github.com/BerriAI/litellm/pull/26957",
      },
    },
  },
  execute: async (
    _toolCallId: string,
    params: { pr_url: string },
    _signal: any,
    onUpdate: any,
  ) => {
    const progress = (msg: string) =>
      onUpdate?.({ type: "progress", text: msg });
    const { card, drilldown } = await reviewPr(params.pr_url, {
      onProgress: progress,
    });
    const text = drilldown ? `${card}\n\n${drilldown}` : card;
    return { content: [{ type: "text" as const, text }] };
  },
});

// --- Agent session factories --------------------------------------------------

async function newSession(
  systemPrompt: string,
  extraTools: ToolDefinition[] = [],
): Promise<AgentSession> {
  const model = defaultModel();
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    ...(model ? { model } : {}),
    customTools: extraTools,
    systemPrompt,
  } as any);
  return session;
}

// --- Security agent (LiteLLM Managed Agent) -----------------------------------

const SECURITY_AGENT_BASE = process.env.SECURITY_AGENT_BASE?.replace(/\/+$/, "") ?? "";
const SECURITY_AGENT_ID = process.env.SECURITY_AGENT_ID ?? "";

async function _spawnSecuritySession(key: string): Promise<string> {
  const r = await fetch(
    `${SECURITY_AGENT_BASE}/v1/managed_agents/agents/${SECURITY_AGENT_ID}/session`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "security review" }),
    },
  );
  if (!r.ok) throw new Error(`security: spawn session HTTP ${r.status}`);
  const data = (await r.json()) as { session_id?: string; id?: string };
  const sid = data.session_id ?? data.id;
  if (!sid) throw new Error("security: no session_id in spawn response");
  return sid;
}

async function _sendSecurityMessage(sessionId: string, text: string, key: string): Promise<string> {
  const r = await fetch(
    `${SECURITY_AGENT_BASE}/v1/managed_agents/sessions/${sessionId}/message`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!r.ok) throw new Error(`security: send message HTTP ${r.status}`);
  const data = (await r.json()) as {
    response?: string; content?: string; text?: string; message?: string;
  };
  return data.response ?? data.content ?? data.text ?? data.message ?? JSON.stringify(data);
}

export async function runSecurityCheck(prUrl: string): Promise<SecurityReport | null> {
  const key = _litellmKey ?? process.env.LITELLM_API_KEY;
  if (!key || !SECURITY_AGENT_BASE || !SECURITY_AGENT_ID) return null;
  try {
    const sessionId = await _spawnSecuritySession(key);
    const response = await _sendSecurityMessage(
      sessionId,
      `Review this GitHub PR for security vulnerabilities: ${prUrl}`,
      key,
    );
    const raw = extractLastJson(response);
    if (raw) {
      return SecurityReportSchema.parse(raw);
    }
    return SecurityReportSchema.parse({ summary: response.trim().slice(0, 500) });
  } catch {
    return null;
  }
}

// --- Karpathy check via Pi SDK ------------------------------------------------

export async function runKarpathyCheck(
  prUrl: string,
): Promise<KarpathyReview | null> {
  try {
    const session = await newSession(KARPATHY_SYSTEM);
    const { output } = await runPrompt(session, `Review this PR: ${prUrl}`);
    session.dispose?.();
    const raw = extractLastJson(output);
    if (!raw) {
      return null;
    }
    return KarpathyReviewSchema.parse(raw);
  } catch {
    return null;
  }
}

// --- Fuse logic (port of Python fuse()) ---------------------------------------

interface TriageCard {
  summary: string;
  size_line: string;
  failing_line: string;
  score: number;
  verdict: "READY" | "BLOCKED" | "WAITING";
  emoji: string;
  verdict_one_liner: string;
  justification: string;
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : word + "s"}`;
}

function join(items: string[], cap = 3): string {
  const head = items.slice(0, cap);
  const tail = items.length > cap ? ` (+${items.length - cap} more)` : "";
  return head.join(", ") + tail;
}

function countSev(p: PatternReport, sev: string): number {
  return p.findings.filter((f) => f.severity === sev).length;
}

function countRisk(p: PatternReport, risk: string): number {
  return p.findings.filter((f) => f.risk === risk).length;
}

function unresolvedPriors(t: TriageReport, severity: string) {
  return t.prior_signals.filter(
    (s) => s.severity === severity && s.status === "agreed",
  );
}

function isWideLowDensityFanout(t: TriageReport): boolean {
  if (t.files_changed < 30) return false;
  const total = t.additions + t.deletions;
  return total / t.files_changed < 5;
}

function karpathyPenalty(k: KarpathyReview | null): [number, string | null] {
  if (!k) return [0, null];
  const gate = k.merge_gate.safe_for_high_rps_gateway;
  const weights: Record<string, number> = { no: 5, conditional: 2 };
  const w = weights[gate] ?? 0;
  if (!w) return [0, null];
  const liner = (k.merge_gate.one_liner ?? "").trim().replace(/\.$/, "");
  const label = liner ? `karpathy ${gate} — ${liner}` : `karpathy ${gate}`;
  return [w, label];
}

export function fuse(
  t: TriageReport,
  p: PatternReport,
  k: KarpathyReview | null = null,
  s: SecurityReport | null = null,
): TriageCard {
  type RubricRow = [
    number,
    (t: TriageReport, p: PatternReport) => boolean,
    (t: TriageReport, p: PatternReport) => string,
  ];
  const rubric: RubricRow[] = [
    [
      5,
      (t) => t.has_merge_conflicts === true,
      () => "merge conflicts (rebase against base branch)",
    ],
    [
      2,
      (t) => t.pr_related_failures.length > 0,
      (t) =>
        `${plural(t.pr_related_failures.length, "PR-related CI failure")} (${join(t.pr_related_failures)})`,
    ],
    [
      2,
      (_t, p) => p.findings.some((f) => f.severity === "blocker"),
      (_t, p) =>
        `${plural(countSev(p, "blocker"), "doc violation")} (${join(p.findings.filter((f) => f.severity === "blocker").map((f) => f.file))})`,
    ],
    [
      2,
      (_t, p) => p.findings.some((f) => f.risk === "high"),
      (_t, p) =>
        `${plural(countRisk(p, "high"), "high-risk pattern finding")} (${join(p.findings.filter((f) => f.risk === "high").map((f) => f.file))})`,
    ],
    [
      1,
      (_t, p) => p.findings.some((f) => f.risk === "medium"),
      (_t, p) =>
        `${plural(countRisk(p, "medium"), "medium-risk pattern finding")} (${join(p.findings.filter((f) => f.risk === "medium").map((f) => f.file))})`,
    ],
    [
      2,
      (t) => t.scope_drift,
      (t) =>
        `scope drift vs linked issue (${t.scope_drift_reason || "see card"})`,
    ],
    [
      2,
      (t) => unresolvedPriors(t, "blocker").length > 0,
      (t) => {
        const b = unresolvedPriors(t, "blocker");
        return `${plural(b.length, "unresolved reviewer blocker")} (${join(b.map((s) => s.source))})`;
      },
    ],
    [
      1,
      (t) => unresolvedPriors(t, "concern").length > 0,
      (t) => {
        const c = unresolvedPriors(t, "concern");
        return `${plural(c.length, "unresolved reviewer concern")} (${join(c.map((s) => s.source))})`;
      },
    ],
    [
      1,
      (t) => isWideLowDensityFanout(t),
      (t) =>
        `wide low-density fan-out (${t.files_changed} files, +${t.additions}/-${t.deletions}) — inline change duplicated across many sites is brittle; prefer a single-source helper`,
    ],
    [
      1,
      (t) => t.greptile_score !== null && (t.greptile_score as number) < 4,
      (t) => `Greptile ${t.greptile_score}/5`,
    ],
    [
      1,
      (t) => t.greptile_score === null,
      () => "Greptile has not reviewed this PR yet",
    ],
  ];

  let score = 5;
  const penalties: string[] = [];
  for (const [w, pred, label] of rubric) {
    if (pred(t, p)) {
      score -= w;
      penalties.push(label(t, p));
    }
  }
  const [kw, kl] = karpathyPenalty(k);
  if (kw) {
    score -= kw;
    if (kl) penalties.push(kl);
  }

  if (s) {
    const criticalFindings = s.findings.filter((f) => f.severity === "critical");
    const highFindings = s.findings.filter((f) => f.severity === "high");
    if (s.overall_risk === "critical" || criticalFindings.length > 0) {
      score -= 3;
      const label = s.summary
        ? `security critical — ${s.summary.slice(0, 100)}`
        : `${plural(criticalFindings.length, "critical security finding")}`;
      penalties.push(label);
    } else if (s.overall_risk === "high" || highFindings.length > 0) {
      score -= 2;
      const files = highFindings.map((f) => f.file || f.vulnerability_type).filter(Boolean);
      const label = files.length
        ? `${plural(highFindings.length, "high-severity security finding")} (${join(files)})`
        : `security high risk — ${s.summary.slice(0, 80) || "see security section"}`;
      penalties.push(label);
    } else if (s.overall_risk === "medium") {
      score -= 1;
      penalties.push(`security medium risk — ${s.summary.slice(0, 80) || "see security section"}`);
    }
  }

  score = Math.max(score, 0);

  let verdict: "READY" | "BLOCKED" | "WAITING";
  let emoji: string;
  if (t.running_checks.length) {
    verdict = "WAITING";
    emoji = "⏳";
  } else if (score === 5) {
    verdict = "READY";
    emoji = "✅";
  } else {
    verdict = "BLOCKED";
    emoji = "❌";
  }

  return {
    summary: t.pr_summary,
    size_line: formatSizeLine(t),
    failing_line: formatFailingLine(t),
    score,
    verdict,
    emoji,
    verdict_one_liner: composeOneLiner(verdict, penalties, t, p, k, s),
    justification: composeJustification(verdict, score, penalties, t, p),
  };
}

function formatSizeLine(t: TriageReport): string {
  const total = t.additions + t.deletions;
  if (!t.files_changed && !total) return "";
  return `${plural(total, "line")} across ${plural(t.files_changed, "file")} (+${t.additions} / -${t.deletions})`;
}

function formatFailingLine(t: TriageReport): string {
  const parts: string[] = [];
  if (t.has_merge_conflicts === true) parts.push("⚠️ merge conflicts");
  const all = [...t.pr_related_failures, ...t.unrelated_failures];
  if (all.length)
    parts.push(`⚠️ ${plural(all.length, "check")} failing: ${join(all)}`);
  if (t.policy_meta_failures.length)
    parts.push(
      `ℹ️ ${plural(t.policy_meta_failures.length, "policy check")} failing: ${join(t.policy_meta_failures)}`,
    );
  return parts.join(" · ");
}

function composeOneLiner(
  verdict: string,
  penalties: string[],
  t: TriageReport,
  p: PatternReport,
  k: KarpathyReview | null,
  s: SecurityReport | null = null,
): string {
  if (verdict === "WAITING")
    return `${plural(t.running_checks.length, "check")} still running: ${join(t.running_checks)}.`;
  if (verdict === "READY") return "Ready to ship.";
  if (t.has_merge_conflicts === true)
    return "Merge conflicts — rebase against base branch first.";
  if (t.pr_related_failures.length)
    return `${plural(t.pr_related_failures.length, "PR-related CI failure")} need fixes first.`;
  const bn = countSev(p, "blocker");
  if (bn) return `${plural(bn, "pattern blocker")} need fixes first.`;
  const bp = unresolvedPriors(t, "blocker");
  if (bp.length)
    return `${plural(bp.length, "unresolved reviewer blocker")} need a response first.`;
  const hr = countRisk(p, "high");
  if (hr)
    return `${plural(hr, "high-risk pattern finding")} need a closer look first.`;
  if (k) {
    const gate = k.merge_gate.safe_for_high_rps_gateway;
    if (gate === "no" || gate === "conditional") {
      const liner = (k.merge_gate.one_liner ?? "").trim().replace(/\.$/, "");
      if (liner) return `${liner}.`;
      return gate === "no"
        ? "Karpathy hold — staff-eng review flagged production risk."
        : "Karpathy conditional — see merge gate for what's needed.";
    }
  }
  if (s) {
    const criticalFindings = s.findings.filter((f) => f.severity === "critical");
    const highFindings = s.findings.filter((f) => f.severity === "high");
    if (s.overall_risk === "critical" || criticalFindings.length > 0) {
      return `Security: critical risk — ${s.summary.slice(0, 120) || "see security section"}.`;
    }
    if (s.overall_risk === "high" || highFindings.length > 0) {
      return `Security: high risk — ${s.summary.slice(0, 120) || "see security section"}.`;
    }
  }
  if (t.scope_drift) {
    const reason = (t.scope_drift_reason || "see card").replace(/\.$/, "");
    return `Scope drift vs linked issue — ${reason}.`;
  }
  return penalties[0]
    ? penalties[0][0].toUpperCase() + penalties[0].slice(1) + "."
    : "See drilldown for details.";
}

function composeJustification(
  verdict: string,
  score: number,
  penalties: string[],
  t: TriageReport,
  p: PatternReport,
): string {
  if (verdict === "WAITING") {
    return `Verdict provisional. Current signals: Greptile ${t.greptile_score === null ? "pending" : `${t.greptile_score}/5`}, ${plural(p.findings.length, "pattern finding")}, CircleCI ${t.has_circleci_checks ? "present" : "absent"}. Score will update once checks complete.`;
  }
  const unique = t.unrelated_failures.filter(
    (n) => !t.unrelated_failures_also_failing_elsewhere.includes(n),
  );
  const unrelSentences: string[] = [];
  if (unique.length)
    unrelSentences.push(
      `${plural(unique.length, "unrelated CI failure")} unique to this PR (${join(unique)}) — not related to this diff but worth a glance.`,
    );
  if (t.unrelated_failures_also_failing_elsewhere.length)
    unrelSentences.push(
      `${plural(t.unrelated_failures_also_failing_elsewhere.length, "check")} also red on neighboring PRs (${join(t.unrelated_failures_also_failing_elsewhere)}) — infra-wide noise, no penalty.`,
    );

  if (verdict === "READY") {
    const ci = t.has_circleci_checks
      ? "CircleCI passed"
      : "no CircleCI runs (OSS-typical)";
    if (t.unrelated_failures.length) {
      const head = `Greptile ${t.greptile_score}/5, no blocking pattern findings, ${ci}. ${plural(t.unrelated_failures.length, "check")} failing but unrelated to this diff: ${join(t.unrelated_failures)}.`;
      return [head, ...unrelSentences].join(" ");
    }
    return `All checks green. Greptile ${t.greptile_score}/5, no blocking pattern findings, ${ci}.`;
  }
  const sentences: string[] = [];
  if (penalties.length)
    sentences.push(`Score docked for: ${penalties.join("; ")}.`);
  sentences.push(...unrelSentences);
  const sugg = countSev(p, "suggestion"),
    nits = countSev(p, "nit");
  const extras: string[] = [];
  if (sugg) extras.push(plural(sugg, "suggestion"));
  if (nits) extras.push(plural(nits, "nit"));
  if (extras.length)
    sentences.push(`Also ${extras.join(" and ")} — see thread.`);
  return sentences.join(" ") || "No specific signal — see thread for detail.";
}

// --- Renderers ----------------------------------------------------------------

export function renderCard(card: TriageCard): string {
  const size = card.size_line ? `_${card.size_line}_\n\n` : "";
  const failing = card.failing_line ? `${card.failing_line}\n` : "";
  return `*Triage Summary*\n${card.summary}\n\n${size}*Merge Confidence: ${card.score}/5*  ${card.emoji} ${card.verdict}\n${failing}${card.verdict_one_liner}\n\n${card.justification}`;
}

export function renderFallbackCard(prUrl: string, error: string): string {
  return `*Triage Summary*\nCould not analyze ${prUrl} automatically.\n\n*Merge Confidence: ?/5*  ⚠️ ERROR\nManual review required.\n\n${error.slice(0, 300)}`;
}

export function renderDrilldown(
  t: TriageReport,
  p: PatternReport,
  k: KarpathyReview | null = null,
  s: SecurityReport | null = null,
): string {
  const lines = ["*Drill-down*"];
  if (t.has_merge_conflicts === true) {
    lines.push(
      "\n_Merge state_",
      "  • merge conflicts — branch must be rebased before it can merge",
    );
  }
  if (t.scope_drift) {
    lines.push(
      "\n_Scope drift vs linked issue_",
      `  • ${t.scope_drift_reason}`,
    );
  }
  const r = t.failure_rationales;
  const bullet = (name: string) =>
    r[name] ? `  • ${name} — ${r[name]}` : `  • ${name}`;
  if (t.pr_related_failures.length) {
    lines.push("\n_PR-related failures_");
    t.pr_related_failures.forEach((c) => lines.push(bullet(c)));
  }
  if (t.unrelated_failures.length) {
    lines.push("\n_Unrelated failures_");
    t.unrelated_failures.forEach((c) => lines.push(bullet(c)));
  }
  if (t.policy_meta_failures.length) {
    lines.push("\n_Policy / meta failures (zero-penalty)_");
    t.policy_meta_failures.forEach((c) =>
      lines.push(
        `  • ${c} — ${r[c] || "operates on PR shape, not code; fix per repo policy"}`,
      ),
    );
  }
  if (t.running_checks.length) {
    lines.push("\n_Still running_");
    t.running_checks.forEach((c) => lines.push(`  • ${c}`));
  }
  if (p.findings.length) {
    lines.push("\n_Pattern findings_");
    const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    [...p.findings]
      .sort((a, b) => (riskOrder[a.risk] ?? 3) - (riskOrder[b.risk] ?? 3))
      .forEach((f) => {
        const rt = f.risk !== "low" ? ` risk=${f.risk}` : "";
        lines.push(
          `  • [${f.severity}${rt}] \`${f.file}\` — ${f.rationale} (source: ${f.source}, ${f.citation})`,
        );
      });
  }
  if (p.tech_debt.length) {
    lines.push("\n_Tech debt (FYI, not blocking)_");
    p.tech_debt.forEach((td) =>
      lines.push(`  • \`${td.code_path}\` vs \`${td.doc_path}\` — ${td.note}`),
    );
  }
  if (t.prior_signals.length) {
    const sevOrd: Record<string, number> = { blocker: 0, concern: 1, nit: 2 };
    const statOrd: Record<string, number> = {
      agreed: 0,
      disagreed: 1,
      out_of_scope: 2,
      resolved: 3,
    };
    const sorted = [...t.prior_signals].sort(
      (a, b) =>
        (statOrd[a.status] ?? 4) - (statOrd[b.status] ?? 4) ||
        (sevOrd[a.severity] ?? 3) - (sevOrd[b.severity] ?? 3),
    );
    lines.push("\n_Prior signals (reviewer + Greptile reconciliation)_");
    sorted.forEach((s) => {
      const glyph = s.status === "agreed" ? "⚠️" : "✓";
      const sevTag = s.severity !== "nit" ? ` [${s.severity}]` : "";
      const tail = s.reason ? ` — reason: ${s.reason}` : "";
      lines.push(
        `  ${glyph} ${s.source}${sevTag} (${s.status}): "${s.excerpt}"${tail}`,
      );
    });
  }
  if (k) {
    const gate = k.merge_gate.safe_for_high_rps_gateway;
    const glyph = { yes: "✅", conditional: "⚠️", no: "❌" }[gate] ?? "?";
    lines.push("\n_Karpathy senior-eng pre-merge review_");
    const liner = (k.merge_gate.one_liner ?? "").trim();
    lines.push(`  ${glyph} merge_gate=${gate}${liner ? ` — ${liner}` : ""}`);
    k.merge_gate.unintended_consequences.forEach((n) =>
      lines.push(`  • risk: ${n}`),
    );
    k.merge_gate.hot_path_notes.forEach((n) =>
      lines.push(`  • hot path: ${n}`),
    );
    if (k.merge_gate.what_would_make_yes)
      lines.push(`  • to unblock: ${k.merge_gate.what_would_make_yes}`);
    k.findings.forEach((f) => {
      let tag = `[${f.breadth}]`;
      if (f.regression_archetype) tag += ` (${f.regression_archetype})`;
      lines.push(`  • ${tag} ${f.bug_class || "?"}`);
      if (f.fix_locus) lines.push(`      fix locus: ${f.fix_locus}`);
      if (f.sibling_loci.length)
        lines.push(`      siblings: ${f.sibling_loci.slice(0, 5).join(", ")}`);
      if (f.recommended_fix)
        lines.push(`      recommend: ${f.recommended_fix}`);
    });
  }
  if (s) {
    const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const sorted = [...s.findings].sort(
      (a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5),
    );
    lines.push("\n_Security review_");
    if (s.overall_risk !== "none") {
      lines.push(`  overall risk: ${s.overall_risk}${s.summary ? ` — ${s.summary}` : ""}`);
    } else if (s.summary) {
      lines.push(`  ${s.summary}`);
    }
    sorted.forEach((f) => {
      const loc = f.file ? ` \`${f.file}\`` : "";
      const type = f.vulnerability_type ? ` [${f.vulnerability_type}]` : "";
      const rec = f.recommendation ? ` → ${f.recommendation}` : "";
      lines.push(`  • [${f.severity}]${type}${loc} — ${f.description}${rec}`);
    });
    if (!sorted.length && !s.summary) {
      lines.push("  No security findings.");
    }
  }

  if (lines.length === 1)
    lines.push("Nothing to drill into. Card has the full story.");
  return lines.join("\n");
}

// --- Core review orchestration ------------------------------------------------

const PR_NUMBER_RE = /\/pull\/(\d+)/;

function prNumberFromUrl(url: string): number | null {
  const m = PR_NUMBER_RE.exec(url);
  return m ? parseInt(m[1], 10) : null;
}

/** When the model returns prose instead of JSON, still drive fuse/drilldown; full text is appended under *Drill-down*. */
function triageReportFromPlainOutput(prUrl: string, prose: string): TriageReport {
  const trimmed = prose.trim();
  const summary =
    trimmed.length <= 600
      ? trimmed || "(empty triage response)"
      : `${trimmed.slice(0, 597)}…`;
  const n = prNumberFromUrl(prUrl);
  return TriageReportSchema.parse({
    pr_number: n ?? 0,
    pr_title: prUrl,
    pr_author: "",
    pr_summary: summary,
    has_circleci_checks: false,
  });
}

// --- Single-shot pattern review (local gather + one LLM call, no tool loop) ---

const _MAX_PATCH  = 800;
const _MAX_DOC    = 500;
const _MAX_SIB    = 400;
const _MAX_PROMPT = 12_000;

function _runGatherLocal(prUrl: string, log: (m: string) => void): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    log("pattern: running local gather");
    const child = spawn("python3", [PATTERN_GATHER_SCRIPT, prUrl], { env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => {
      const line = d.toString();
      stderr += line;
      line.split("\n").filter(Boolean).forEach((l) => log(`gather: ${l.trim()}`));
    });
    child.on("close", (code: number) => {
      if (code !== 0) reject(new Error(`gather exited ${code}: ${stderr.slice(0, 400)}`));
      else {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(`gather output not JSON: ${stdout.slice(0, 200)}`)); }
      }
    });
  });
}

function _buildPatternPrompt(prUrl: string, g: Record<string, unknown>): string {
  const files  = (g.diff_files        as any[]) ?? [];
  const docs   = (g.doc_excerpts      as any[]) ?? [];
  const sibs   = (g.sibling_excerpts  as any[]) ?? [];
  const parts: string[] = [`PR: ${prUrl}\n\n`, "## Diff\n\n"];

  for (const f of files) {
    let patch = (f.patch as string) ?? "";
    if (patch.length > _MAX_PATCH) patch = patch.slice(0, _MAX_PATCH) + "\n... [patch truncated]";
    parts.push(`### \`${f.filename}\`\n\`\`\`diff\n${patch}\n\`\`\`\n\n`);
  }
  if (docs.length) {
    parts.push("## Relevant doc excerpts\n\n");
    for (const d of docs) {
      const exc = ((d.excerpt as string) ?? "").slice(0, _MAX_DOC);
      const matched = ((d.matched_files as string[]) ?? []).join(", ");
      parts.push(`**\`${d.path}\`** (matched \`${matched}\`):\n\`\`\`\n${exc}\n\`\`\`\n\n`);
    }
  }
  if (sibs.length) {
    parts.push("## Sibling file excerpts\n\n");
    for (const sg of sibs) {
      parts.push(`**For \`${sg.diff_file}\`:**\n`);
      for (const s of (sg.siblings as any[])) {
        const head = ((s.head_excerpt as string) ?? "").slice(0, _MAX_SIB);
        parts.push(`\`${s.path}\`:\n\`\`\`\n${head}\n\`\`\`\n\n`);
      }
    }
  }
  let prompt = parts.join("");
  if (prompt.length > _MAX_PROMPT) prompt = prompt.slice(0, _MAX_PROMPT) + "\n\n... [prompt truncated]";
  return prompt;
}

async function _patternSingleShot(prUrl: string, log: (m: string) => void): Promise<string> {
  const gatherData = await _runGatherLocal(prUrl, log);
  const userPrompt = _buildPatternPrompt(prUrl, gatherData);
  log(`pattern: single-shot LLM call, prompt=${userPrompt.length} chars`);

  const base  = _litellmBase  ?? process.env.LITELLM_API_BASE?.replace(/\/+$/, "");
  const key   = _litellmKey   ?? process.env.LITELLM_API_KEY;
  const model = defaultModelId ?? process.env.LITELLM_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6";

  const resp = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: PATTERN_SYSTEM_SINGLE_SHOT },
        { role: "user",   content: userPrompt },
      ],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`LLM call failed HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content ?? "";
}

// --- Core review orchestration ------------------------------------------------

export async function reviewPr(
  prUrl: string,
  opts: {
    source?: string;
    channel?: string | null;
    threadTs?: string | null;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<{
  card: string;
  drilldown: string;
  runId: string;
  toolTrace: ToolTraceEntry[];
}> {
  const t0 = Date.now();
  const runId = randomUUID().replace(/-/g, "");
  const source = opts.source ?? "chat";
  const log = (msg: string) => {
    opts.onProgress?.(msg);
  };

  let triage: TriageReport | null = null;
  let pattern: PatternReport | null = null;
  let security: SecurityReport | null = null;
  let triageTrace: ToolTraceEntry[] = [];
  let patternTrace: ToolTraceEntry[] = [];
  let triageErr = "";
  let patternErr = "";
  let triagePlainAppend = "";
  let patternPlainAppend = "";

  log(`starting triage + pattern in parallel for ${prUrl}`);
  // Run triage + pattern + security in parallel
  await Promise.all([
    (async () => {
      try {
        log("triage: creating session");
        const session = await newSession(TRIAGE_SYSTEM);
        log("triage: running gather + analysis");
        let { output: triageOut, toolTrace: tt } = await runPrompt(
          session,
          `Triage this PR: ${prUrl}`,
        );
        triageTrace = tt;
        const raw = extractLastJson(triageOut);
        session.dispose?.();
        if (raw) {
          triage = TriageReportSchema.parse(raw);
          log("triage: done ✓");
        } else {
          triage = triageReportFromPlainOutput(prUrl, triageOut);
          triagePlainAppend = triageOut.trim();
          log("triage: done (plain output)");
        }
      } catch (e) {
        triageErr = String(e);
        log(`triage: ERROR — ${e}`);
      }
    })(),
    (async () => {
      try {
        const t0pat = Date.now();
        const patternOut = await _patternSingleShot(prUrl, log);
        const raw = extractLastJson(patternOut);
        if (raw) {
          pattern = PatternReportSchema.parse(raw);
          log(`pattern: done ✓  ${((Date.now() - t0pat) / 1000).toFixed(1)}s`);
        } else {
          pattern = PatternReportSchema.parse({});
          patternPlainAppend = patternOut.trim();
          log("pattern: done (plain output)");
        }
      } catch (e) {
        patternErr = String(e);
        log(`pattern: ERROR — ${e}`);
      }
    })(),
  ]);

  const allTrace = [...triageTrace, ...patternTrace];
  const duration = (Date.now() - t0) / 1000;

  if (!triage || !pattern) {
    const err =
      [triageErr, patternErr].filter(Boolean).join("\n") ||
      "unknown agent failure";
    const card = renderFallbackCard(prUrl, err);
    log("karpathy check: failed");
    await db
      .insertRun({
        run_id: runId,
        ts: Date.now() / 1000,
        pr_url: prUrl,
        pr_number: prNumberFromUrl(prUrl),
        pr_title: prUrl,
        pr_author: "",
        source,
        channel: opts.channel ?? null,
        thread_ts: opts.threadTs ?? null,
        duration_s: duration,
        tool_trace: allTrace,
        triage: null,
        pattern: null,
        card: null,
        messages: { triage: [], pattern: [] },
        karpathy_check: {},
      })
      .catch(() => {});
    return { card, drilldown: "", runId, toolTrace: allTrace };
  }

  log("starting provisional fuse");

  // Karpathy + security run only when triage+pattern would READY
  const provisional = fuse(triage, pattern);
  let karpathy: KarpathyReview | null = null;
  log(`provisional verdict: ${JSON.stringify(provisional)}`);
  if (provisional.verdict === "READY") {
    log("karpathy + security check: running");
    [karpathy, security] = await Promise.all([
      runKarpathyCheck(prUrl).catch(() => null),
      runSecurityCheck(prUrl).then(
        (r) => { log(r ? "security: done ✓" : "security: skipped (no key)"); return r; },
        (e) => { log(`security: ERROR — ${e}`); return null; },
      ),
    ]);
  }

  const card = fuse(triage, pattern, karpathy, security);
  const cardText = renderCard(card);
  let drilldown = renderDrilldown(triage, pattern, karpathy, security);
  if (triagePlainAppend) {
    drilldown +=
      "\n\n_Triage agent output (no JSON; verbatim)_\n\n" + triagePlainAppend;
  }
  if (patternPlainAppend) {
    drilldown +=
      "\n\n_Pattern agent output (no JSON; verbatim)_\n\n" + patternPlainAppend;
  }

  log(`card: ${JSON.stringify(card)}`);

  await db
    .insertRun({
      run_id: runId,
      ts: Date.now() / 1000,
      pr_url: prUrl,
      pr_number: triage?.pr_number ?? null,
      pr_title: triage?.pr_title ?? null,
      pr_author: triage?.pr_author ?? null,
      source,
      channel: opts.channel ?? null,
      thread_ts: opts.threadTs ?? null,
      duration_s: duration,
      tool_trace: allTrace,
      triage: triage,
      pattern: pattern,
      card: card,
      messages: { triage: [], pattern: [] },
      karpathy_check: karpathy ?? {},
    })
    .catch(() => {});

  return { card: cardText, drilldown, runId, toolTrace: allTrace };
}

// --- Chat session management --------------------------------------------------

type Turn = {
  role: "user" | "assistant";
  content: string;
  tool_trace?: ToolTraceEntry[];
};
type Thread = {
  id: string;
  title: string;
  updated_at: number;
  agent: AgentSession | null;
  turns: Turn[];
  // Serialise prompts: each call chains onto this promise so concurrent
  // requests queue rather than crashing with "Agent is already processing".
  queue: Promise<unknown>;
};

const THREADS = new Map<string, Thread>();

export async function ensureChatSession(
  threadId: string,
  title?: string,
): Promise<Thread> {
  let thread = THREADS.get(threadId);
  if (!thread) {
    thread = {
      id: threadId,
      title: title ?? "New chat",
      updated_at: Date.now() / 1000,
      agent: null,
      turns: [],
      queue: Promise.resolve(),
    };
    THREADS.set(threadId, thread);
  } else if (title && thread.title === "New chat") {
    thread.title = title;
  }
  // Lazily create agent session on first use (or if null from createThread)
  if (!thread.agent) {
    thread.agent = await newSession(CHAT_SYSTEM, [reviewPrTool]);
  }
  return thread;
}

function getAvailableTools(thread: Thread): string[] {
  const agentAny = thread.agent as any;
  return (
    agentAny?.tools?.map((t: any) => t.name) ??
    agentAny?.runtime?.tools?.map((t: any) => t.name) ??
    agentAny?.state?.tools?.map((t: any) => t.name) ??
    []
  );
}

async function runQueued<T>(thread: Thread, fn: () => Promise<T>): Promise<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  thread.queue = thread.queue.then(() => fn().then(resolve, reject));
  return result;
}

export async function promptChatSession(
  threadId: string,
  message: string,
  title?: string,
): Promise<{
  output: string;
  toolTrace: ToolTraceEntry[];
  threadId: string;
  availableTools: string[];
}> {
  const thread = await ensureChatSession(threadId, title);
  const availableTools = getAvailableTools(thread);
  return runQueued(thread, async () => {
    const { output, toolTrace } = await runPrompt(thread.agent!, message);
    thread.turns.push({ role: "user", content: message });
    thread.turns.push({
      role: "assistant",
      content: output,
      tool_trace: toolTrace,
    });
    thread.updated_at = Date.now() / 1000;
    return { output, toolTrace, threadId, availableTools };
  });
}

export async function promptChatSessionStreaming(
  threadId: string,
  message: string,
  title: string | undefined,
  onStream: (event: StreamEvent) => void,
): Promise<{
  output: string;
  toolTrace: ToolTraceEntry[];
  threadId: string;
  availableTools: string[];
}> {
  const thread = await ensureChatSession(threadId, title);
  const availableTools = getAvailableTools(thread);
  return runQueued(thread, async () => {
    const { output, toolTrace } = await runPrompt(
      thread.agent!,
      message,
      onStream,
    );
    thread.turns.push({ role: "user", content: message });
    thread.turns.push({
      role: "assistant",
      content: output,
      tool_trace: toolTrace,
    });
    thread.updated_at = Date.now() / 1000;
    return { output, toolTrace, threadId, availableTools };
  });
}

export function listThreads(): {
  id: string;
  title: string;
  updated_at: number;
}[] {
  return [...THREADS.values()]
    .map(({ id, title, updated_at }) => ({ id, title, updated_at }))
    .sort((a, b) => b.updated_at - a.updated_at);
}

export function getThread(threadId: string): Thread | undefined {
  return THREADS.get(threadId);
}

export function deleteThread(threadId: string): boolean {
  const t = THREADS.get(threadId);
  if (!t) return false;
  t.agent.dispose?.();
  return THREADS.delete(threadId);
}

export function createThread(
  threadId?: string,
  title?: string,
): { id: string; title: string; updated_at: number } {
  const id = threadId ?? randomUUID().replace(/-/g, "");
  const now = Date.now() / 1000;
  const thread: Thread = {
    id,
    title: title ?? "New chat",
    updated_at: now,
    agent: null,
    turns: [],
    queue: Promise.resolve(),
  };
  THREADS.set(id, thread);
  return { id, title: thread.title, updated_at: now };
}
