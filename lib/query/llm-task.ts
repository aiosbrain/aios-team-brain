/**
 * The task vocabulary for `source='llm'` outcome rows (LLMOBS-1 / AIO-905).
 *
 * A named union rather than free strings, in its own module with no `server-only` import, so the
 * recording call sites (which live under `lib/meetings`, `lib/graph`, …) and the health read that
 * partitions by it cannot drift apart. Adding a member here without a `TASK_COPY` entry is safe by
 * construction — `taskLabel` has a fallback — but a member that no call site emits is dead, and a
 * call site emitting a string not in this union is a typecheck error.
 *
 * The two meetings passes are SEPARATE members deliberately: they run back-to-back on every trigger
 * with action items last, so one shared name lets the later success mask the earlier failure.
 */
export const LLM_TASK_NAMES = [
  "arcs",
  "arc-coherence",
  "meeting-summary",
  "meeting-actions",
  "meeting-merge",
  "attribution",
] as const;

/**
 * A runtime ARRAY with the type derived from it, not a bare type union — so a guard can iterate the
 * vocabulary. Review found that the label-sync test hard-coded its own list of six slugs, which meant
 * adding a seventh task to the union and to the server's copy map while forgetting the client's would
 * stay green and render a raw slug on Pulse. A hard-coded list in a guard is a second source of truth.
 */
export type LlmTaskName = (typeof LLM_TASK_NAMES)[number];
