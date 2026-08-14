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
export type LlmTaskName =
  | "arcs"
  | "arc-coherence"
  | "meeting-summary"
  | "meeting-actions"
  | "meeting-merge"
  | "attribution";
