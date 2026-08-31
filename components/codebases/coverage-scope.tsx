import { AlertTriangle } from "lucide-react";
import { isUnscopedCoverage } from "@/lib/codebases/score";
import {
  MIN_SCANNER_VERSION,
  isScannerOutdated,
  scannerStalenessLabel,
  scannerStalenessNoun,
  type ScannerStaleness,
} from "@/lib/codebases/scanner-version";

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
 *
 * **And, since 1.24 (AIO-1011): unknown scope now names its CAUSE.** "(scope unknown)" was true
 * and unactionable. The reason it was true for all seven repos was that each was pinned to a
 * scanner build predating the field — 1.22 shipped, every scan returned 200, and the feature
 * never arrived. A caveat that cannot be acted on is only marginally better than silence, so when
 * the scan declares a build older than the contract needs (or declares none at all), the marker
 * says so where the reader meets the confusion, not in a log nobody opens.
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
  scannerStaleness,
  scannerVersion,
  className = "",
}: {
  linesInstrumented: number | null;
  loc: number | null;
  breadthPct: number | null;
  /**
   * Which scanner build produced the scan (brain-api 1.24). Optional so a caller that genuinely
   * has no scan context can omit it — omitted is treated as `"unknown"`, never as `"current"`,
   * because defaulting to "current" would reinstate exactly the silent pass this fixes.
   */
  scannerStaleness?: ScannerStaleness;
  scannerVersion?: string | null;
  className?: string;
}) {
  if (linesInstrumented == null || loc == null || loc <= 0) {
    // The cause, when we know it. A scan from a scanner that predates the field could not have
    // reported scope no matter what the repo did — so "re-scan" is the wrong advice and "bump the
    // pin" is the right one. Where the scanner IS current, the scope is genuinely missing (no
    // coverage report parsed the counts) and the original wording still holds.
    const cause = scannerStalenessLabel(scannerStaleness ?? "unknown", scannerVersion);
    return (
      <span
        title={
          cause
            ? `${cause}. The percentage above could describe the whole repository or a small corner of it. Bump this repo's scanner pin in .github/scripts/fetch-brain-scanner.sh to a build at or after ${MIN_SCANNER_VERSION} — the exact-SHA pin is deliberate, so it is bumped, never removed.`
            : "This scan ran a current scanner but did not report how many lines the coverage run measured, so the percentage above could describe the whole repository or a small corner of it."
        }
        className={`font-mono text-[10px] text-ink-tertiary italic ${className}`}
      >
        {cause
          ? `(scope unknown — ${scannerStalenessNoun(scannerStaleness ?? "unknown")})`
          : "(scope unknown)"}
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

/**
 * "scanner outdated" badge — the repo's pinned scanner cannot send what the contract now asks for.
 *
 * Rendered independently of coverage, because the consequence is not limited to coverage: an old
 * scanner under-reports whatever the newest revision added, and the next revision will add
 * something else. A repo with no coverage number at all still needs its pin bumped.
 *
 * `"current"` renders NOTHING. `"unknown"` DOES render — that is the whole discipline: a scan that
 * declined to say what built it is not evidence of a current build, and every scan pushed before
 * 1.24 is in exactly that state. The two non-current states carry DIFFERENT words, because they
 * have different remedies.
 */
export function ScannerStalenessBadge({
  staleness,
  scannerVersion,
  scannerSha = null,
}: {
  staleness: ScannerStaleness;
  scannerVersion: string | null;
  /**
   * The brain commit the scan ran from, when known. Rendered into THIS element's own title
   * rather than a wrapper's: a nested `title` shadows its ancestor's on hover, so a wrapping
   * span whose box is exactly this badge's box can never be hovered independently — the
   * provenance would be stored, tested, and unreachable. It belongs here because it is the
   * answer to the question the badge provokes: which pin do I bump?
   */
  scannerSha?: string | null;
}) {
  const label = scannerStalenessLabel(staleness, scannerVersion);
  if (!label || !isScannerOutdated(staleness)) return null;
  const provenance = scannerSha
    ? ` This scan was built from aios-team-brain commit ${scannerSha}.`
    : " This scan did not record which commit built it.";
  return (
    <span
      title={`${label}.${provenance} Bump this repo's pin in .github/scripts/fetch-brain-scanner.sh to a scanner build at or after ${MIN_SCANNER_VERSION}. The exact-SHA pin is deliberate — it keeps another repo's code from executing in your CI unreviewed — so it is bumped, never removed.`}
      className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500/90"
    >
      <AlertTriangle className="size-2.5" />
      {staleness === "unknown" ? "scanner unknown" : "scanner outdated"}
    </span>
  );
}
