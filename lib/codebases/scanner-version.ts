/**
 * Which scanner build produced a scan, and whether it can still say what the contract asks —
 * brain-api 1.24 (AIO-1011).
 *
 * **The failure this exists for.** brain-api 1.22 shipped the coverage denominator and it never
 * arrived. Every consuming repo fetches the scanner pinned to an exact commit in its own
 * `.github/scripts/fetch-brain-scanner.sh`, and all seven were pinned to a build from three weeks
 * before the field existed. Every scan returned 200. Nothing went red. This surface rendered
 * `(scope unknown)` for the whole fleet and the KPI read "7 reporting · 7 without scope" — both
 * true, neither explaining anything — and it was caught because a human looked at a screenshot.
 *
 * The pin is a deliberate supply-chain control and is not the defect: that code executes in
 * another repo's CI holding that repo's brain credentials. The defect is that the unknown-scope
 * state had no attributable CAUSE at the point where a reader met it, so a permanent failure was
 * indistinguishable from a transient one.
 *
 * ## Why a declared minimum, and not a commit distance
 *
 * "149 commits behind" is easy to compute and means almost nothing:
 *
 *   - it is undefined across branches and forks — a fork's scanner is not N commits behind anything;
 *   - it needs a git history this server does not hold at runtime;
 *   - it stops existing the moment the scanner ships from a package index (AIO-1011 part 4);
 *   - decisively, it says nothing about whether anything the contract needs actually CHANGED. 149
 *     commits of website copy and 149 commits of scanner rewrites produce the same number.
 *
 * {@link MIN_SCANNER_VERSION} is instead a STATEMENT: the oldest build that emits everything the
 * current contract asks a scanner for. It is declared canonically in
 * `aios-workspace/docs/contract/brain-contract.json` →
 * `codebasePayloadContract.minScannerVersion`, inside the hashed content set, vendored here, and
 * pinned to this constant by `test/guards/contract-conformance.test.ts` so the two cannot drift.
 *
 * **The cost is real and is named here rather than discovered later.** A declared minimum only
 * moves when a human moves it: if a future revision adds a field the scanner must emit and forgets
 * to raise the minimum, staleness detection is silently off for that field — the same shape of
 * silence 1.22 shipped. Raising it belongs in the same PR as the field. That is a discipline cost
 * paid for a number that means something, which is the trade this feature exists to make.
 *
 * ## Unknown is not a failure, and is never a pass
 *
 * A scan with no `scanner_version` is every scan ever pushed before 1.24, and the field cannot be
 * backfilled — so `"unknown"` is the COMMON state, not an edge case. It renders as a caveat, never
 * as "current", and it never rejects anything: an unparseable version reads as unknown, because a
 * 422 drops the repo's entire scan (metrics, findings, contributions, issues) and returns before
 * the ingest run is even recorded, so the failure would not even be logged.
 */

/**
 * The oldest scanner build that emits everything brain-api 1.24 asks for.
 *
 * MIRROR — the canonical declaration is `codebasePayloadContract.minScannerVersion` in the
 * contract fixture; the guard test asserts this constant equals it. Raise BOTH, in the same PR as
 * any revision that requires new scanner output.
 */
export const MIN_SCANNER_VERSION = "0.2.0";

/** How a scan's declared build compares to what the contract needs. */
export type ScannerStaleness = "current" | "stale" | "unknown";

/**
 * `[major, minor, patch]`, or null when the string is not an ordered release version.
 *
 * STRICT: exactly three dotted non-negative integers, and nothing else. Any suffix — `0.2.0-rc1`,
 * `0.2.0+dirty`, `0.2.0-alpha.1`, the malformed `0.2.0-`, or a fourth component `1.0.0.0` — is
 * UNREADABLE and returns null, which the table above resolves to `"unknown"`.
 *
 * **This was lenient in the first draft and that was a bug.** It stripped the suffix and compared
 * the numeric core, which produced two wrong answers. `0.2.0-alpha.1` read as `current` even
 * though a SemVer prerelease sorts BEFORE its release, so if anything it is behind. Worse,
 * `0.1.0-rc.1` read as `stale` — a verdict about ordering derived from a string this function had
 * just failed to fully understand. That is the same prior-as-fact error removed twice already
 * from this feature: reporting a measurement that was never made. Unreadable resolves to
 * `"unknown"` BEFORE any ordering happens, and the boundary is exactly here.
 *
 * Failing safe costs something real and it is the right trade: a genuine `0.2.0-rc1` build now
 * reads `"unknown"` rather than `"current"`, so a release candidate is flagged as unidentified.
 * "I could not read this" is a true statement; "this is current" would have been a guess.
 *
 * The grammar deliberately MIRRORS the scanner's own `_VERSION_RE`
 * (`ingestion/aios_ingest/build.py`), which voids the same shapes to `None` at its own choke
 * point. Both sides must agree on what counts as a version: if the scanner considered a suffixed
 * string valid and sent it, the brain would read `"unknown"` and the repo would flag itself for
 * no reason. The contract deliberately does NOT pin this grammar (its `scanner_state` vectors
 * carry no suffixed cases) — it is the reader's to define, so it is defined here and covered by
 * this repo's unit tests.
 */
export function parseScannerVersion(
  raw: string | null | undefined
): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Lexicographic on the numeric triple. -1 / 0 / 1. */
function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Classify a scan's scanner build.
 *
 * `null`, absent, or unparseable ⇒ `"unknown"`. That is deliberate and load-bearing: the one
 * reading a missing version must never produce is `"current"`. Absence of evidence is not
 * evidence of currency — it is precisely the state the whole fleet was in while 1.22 quietly
 * failed to arrive.
 */
export function scannerStaleness(
  scannerVersion: string | null | undefined,
  minVersion: string = MIN_SCANNER_VERSION
): ScannerStaleness {
  const declared = parseScannerVersion(scannerVersion);
  if (!declared) return "unknown";
  const min = parseScannerVersion(minVersion);
  // An unparseable MINIMUM is a bug in this repo, not in the payload. Refusing to guess: with no
  // threshold there is no staleness claim to make, and inventing one would flag the whole fleet.
  if (!min) return "unknown";
  return compare(declared, min) < 0 ? "stale" : "current";
}

/** True when the scan cannot be trusted to have sent everything the contract asks for. */
export function isScannerOutdated(staleness: ScannerStaleness): boolean {
  return staleness !== "current";
}

/**
 * The SHORT noun phrase for a non-current scanner — one vocabulary, used by every surface.
 *
 * This exists because the two non-current states kept getting collapsed into the word "stale" at
 * individual call sites, which is a false statement about the unknown ones: they did not declare
 * an old build, they declared nothing. That mistake was made twice in this feature's own first
 * draft (the coverage KPI hint and the `(scope unknown)` marker), which is the argument for
 * deriving the words from one function rather than retyping them per component.
 *
 * `"current"` returns null — a repo on a current scanner is never labelled at all.
 */
export function scannerStalenessNoun(staleness: ScannerStaleness): string | null {
  if (staleness === "current") return null;
  return staleness === "stale" ? "outdated scanner" : "scanner not identified";
}

/**
 * One sentence naming the cause, for the place the reader meets the effect.
 *
 * Kept beside the rule rather than in a component so the card, the detail page and the KPI hint
 * cannot tell three different stories about the same repo. Returns null for `"current"` — a repo
 * on a current scanner shows no flag at all.
 */
export function scannerStalenessLabel(
  staleness: ScannerStaleness,
  scannerVersion: string | null | undefined,
  minVersion: string = MIN_SCANNER_VERSION
): string | null {
  if (staleness === "current") return null;
  if (staleness === "unknown") {
    // Includes the case where a version arrived but could not be read — same remedy, and naming
    // the unreadable string is more use to whoever has to fix it than "unknown" alone.
    const seen =
      typeof scannerVersion === "string" && scannerVersion.trim()
        ? ` ("${scannerVersion.trim()}")`
        : "";
    return `scanner build unknown${seen} — this scan predates brain-api 1.24, so it could not report coverage scope`;
  }
  return `scanner ${scannerVersion} predates ${minVersion} — this scan could not report coverage scope`;
}

/**
 * Normalize what the wire sent into what gets STORED.
 *
 * The wire schema is deliberately permissive (any bounded string) so a malformed value can never
 * 422 a whole scan. Storage keeps the string VERBATIM anyway — including one we cannot parse —
 * because provenance is exactly what you want when diagnosing a fleet, and the interpretation
 * (unknown) happens at read time via {@link scannerStaleness}. Only the empty/whitespace case
 * collapses to null: an empty string is not a claim about anything.
 */
export function normalizeStoredScannerField(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" ? null : value;
}
