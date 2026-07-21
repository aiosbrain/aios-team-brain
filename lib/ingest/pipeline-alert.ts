import type { PipelineLeg } from "./pipeline-health";

/**
 * Stable signature of the CURRENT failing-leg set, used to persist a banner dismissal. Dismissing the
 * pipeline-health alert stores this string; the banner stays hidden only while the signature matches.
 * A DIFFERENT set of failures (a new leg breaks, an error message changes, or a leg recovers) yields a
 * new signature, so the alert re-appears — you can ack the problem you've seen but can't permanently
 * blind yourself to a new one. Order-independent (sorted) so leg ordering never changes the key.
 * Pure + unit-tested. (Type-only import of `PipelineLeg` — no server-only runtime pulled into the client.)
 */
export function alertSignature(failing: PipelineLeg[]): string {
  return failing
    .map((l) => `${l.source}:${l.ok ? "stale" : "fail"}:${(l.error ?? "").trim()}`)
    .sort()
    .join("|");
}
