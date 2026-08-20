import { AlertTriangle } from "lucide-react";
import { isUnscopedCoverage } from "@/lib/codebases/score";

export { isUnscopedCoverage };

/**
 * Coverage rendered WITH the scope it was measured over (brain-api 1.22 / AIO-995).
 *
 * A bare `99%` is not a claim about a repository — it is a claim about whatever the runner
 * instrumented. `99% (436 / 3,140 lines)` is. One component so the card and the detail
 * breakdown state the scope the same way and can't drift into two different stories.
 *
 * **The scope is not optional furniture.** An earlier version of this file rendered the counts
 * when they existed and nothing when they didn't, which left a repo with no denominator showing
 * exactly the bare `99%` this feature was built to abolish — and that is the state of EVERY row
 * until its next scan, so the common case was the unfixed one. Unknown scope now renders as
 * "scope unknown", explicitly. The three states are:
 *
 *   • scope known and broad   → the percentage with its counts, plain.
 *   • scope known and NARROW  → the same, visually marked. Not an error and not a penalty; a
 *                               reader who skims the number needs to see that it covers a
 *                               fraction of the repo before they compare it to anything.
 *   • scope UNKNOWN           → the percentage plus an explicit "scope unknown" marker. Never
 *                               a zero, never a dash in a denominator slot, and never silence —
 *                               silence is what let the number read as a whole-repo claim.
 */

export const NARROW_BREADTH_PCT = 50;

export function isNarrowCoverage(breadthPct: number | null): boolean {
  return breadthPct != null && breadthPct < NARROW_BREADTH_PCT;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The scope suffix — `(436 / 3,140 lines)`, or an explicit `scope unknown`.
 *
 * Renders SOMETHING in every case where a percentage is shown. `loc = 0` counts as unknown:
 * there is no denominator to divide by, and a repo with no counted lines cannot have a
 * meaningful breadth.
 */
export function CoverageScope({
  linesInstrumented,
  loc,
  breadthPct,
  className = "",
}: {
  linesInstrumented: number | null;
  loc: number | null;
  breadthPct: number | null;
  className?: string;
}) {
  if (linesInstrumented == null || loc == null || loc <= 0) {
    return (
      <span
        title="This scan did not report how many lines the coverage run measured, so the percentage above could describe the whole repository or a small corner of it. Re-scan with a current scanner to record the scope."
        className={`font-mono text-[10px] text-ink-tertiary italic ${className}`}
      >
        (scope unknown)
      </span>
    );
  }
  const narrow = isNarrowCoverage(breadthPct);
  // The counts and the ratio are separate props, so a caller can supply the pair without the
  // percentage. Say "N of M lines" then, rather than interpolating a literal "null%".
  const share = breadthPct == null ? "" : ` (${breadthPct}% of the repo)`;
  return (
    <span
      title={
        `Measured over ${fmt(linesInstrumented)} of ${fmt(loc)} counted lines${share}.` +
        (narrow ? " This percentage describes a minority of the code." : "")
      }
      className={`font-mono text-[10px] ${narrow ? "text-amber-500/90" : "text-ink-tertiary"} ${className}`}
    >
      ({fmt(linesInstrumented)} / {fmt(loc)} lines)
    </span>
  );
}

/**
 * "partial run" badge — non-zero skipped or failed cases in the run behind the coverage number.
 *
 * `partial === null` (no test-result report) renders nothing: completeness is unknown, and an
 * absent report must never be dressed up as a clean one.
 */
export function PartialRunBadge({
  partial,
  skipped,
  failed,
  total,
}: {
  partial: boolean | null;
  skipped: number | null;
  failed: number | null;
  total: number | null;
}) {
  if (partial !== true) return null;
  const parts = [
    skipped != null && skipped > 0 ? `${fmt(skipped)} skipped` : null,
    failed != null && failed > 0 ? `${fmt(failed)} failed` : null,
  ].filter(Boolean);
  return (
    <span
      title={`${parts.join(", ")} of ${total == null ? "?" : fmt(total)} tests — coverage was measured on an incomplete run.`}
      className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500/90"
    >
      <AlertTriangle className="size-2.5" />
      partial
    </span>
  );
}
