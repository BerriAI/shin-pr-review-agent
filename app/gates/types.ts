// Shared types for the deterministic pre-review gates.
// Gates run before the LLM pipeline (triage / pattern / karpathy) and short-
// circuit reviewPr when one fires. Each gate is a pure function of the
// gather output plus parsed overrides.

export type DiffFile = {
  filename: string;
  status?: string;
  additions: number;
  deletions: number;
  patch?: string;
};

// Subset of the gather JSON that gates actually consume. Keep this narrow on
// purpose — every field added here is a contract the gather script must keep
// emitting.
export type GatherData = {
  pr_number: number;
  pr_title: string;
  pr_body: string;
  pr_labels: string[];
  pr_comments: string[];
  diff_files: DiffFile[];
  greptile_score: number | null;
};

export type GateCategory =
  | "greptile"
  | "size"
  | "logging_screenshot"
  | "screenshot";

export type GateBlock = {
  category: GateCategory;
  // One sentence, surfaces in pr_summary so the PR author sees it.
  reason: string;
};

export type Overrides = {
  // Bypass the size gate. Signaled by PR label `oversized-ok` or commit-
  // trailer `Big-PR-Approved: <handle>` in the PR body.
  oversized_ok: boolean;
};

export type Gate = {
  name: string;
  evaluate: (g: GatherData, o: Overrides) => GateBlock | null;
  // Gate-specific facts the gate examined (score, file_count, etc). Always
  // returned — independent of pass/fail — so observability persists evidence
  // for gates that did not block too. Keeping this on the Gate (rather than
  // reaching into internals from index.ts) keeps each gate's evidence
  // co-located with its evaluation logic.
  evidence: (g: GatherData, o: Overrides) => Record<string, unknown>;
};

// Result of one gate's evaluation. `runGates` returns one of these per gate,
// regardless of whether the gate blocked. `firstBlock` on the wrapper return
// preserves short-circuit semantics for callers that only care about the
// first failing gate.
export type GateEvaluation = {
  gate: string;            // gate.name from each Gate
  blocked: boolean;
  reason: string | null;   // GateBlock.reason if blocked, else null
  evidence: Record<string, unknown>; // gate-specific facts
};
