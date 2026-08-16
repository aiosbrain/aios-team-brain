import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arcTtlMs, ARC_CACHE_TTL_MS, UNTRUSTED_RETRY_AFTER_MS } from "@/lib/graph/arc-cache";

/**
 * BUILD-FAILING GUARD: a cache writer may not FABRICATE a timestamp — derive one by subtracting a
 * DURATION from the clock — to encode something other than when the payload was computed
 * (Pass-1 review R2/M6, follow-up to PR #426).
 *
 * `writeArcCache` used to write `computed_at = now - (TTL - RETRY)` for a synthesis it didn't trust: not
 * to describe the row's age, but to make it go stale sooner so the next view retries. The behaviour was
 * right and the timestamp lied by ~4 hours, which #426's freshness envelope then had to publish. The fix
 * gave the verdict its own column and DERIVED the short life from it (`arcTtlMs`), so the two meanings
 * stopped sharing one field.
 *
 * THE DISCRIMINATOR. Both shapes subtract from `Date.now()`, so "arithmetic on the clock" is too coarse:
 *   • `Date.now() - prior.at`            → subtracting a TIMESTAMP = computing an AGE. Legitimate.
 *   • `Date.now() - ARC_CACHE_TTL_MS`    → subtracting a DURATION  = fabricating a TIME. The bug.
 * So the pattern keys on a `*_MS`-named operand after the minus. Verified against every clock
 * subtraction in these three files at the buggy commit: it flags exactly the four fabrications and
 * neither of the two age computations.
 *
 * WHY IT'S WRITTEN OVER THE WHOLE FILE, NOT LINE BY LINE. The first version of this guard matched single
 * lines and reported ZERO offenders against the very commit that contained the bug — because the real
 * `writeArcCache` fabrication was a prettier-wrapped multi-line ternary, and the real `commitArcs` one
 * assigned to a local (`const at = untrustworthy ? Date.now() - … : Date.now()`) with no `computed_at:`
 * on the line at all. Its "non-vacuous" test passed only because it asserted a single-line paraphrase
 * that never existed in the codebase. The fixtures below are now the VERBATIM shapes from that commit.
 *
 * KNOWN BLIND SPOTS:
 *   • A duration that isn't `*_MS`-named (`Date.now() - 300000`, `Date.now() - FIVE_MINUTES`) is missed.
 *   • A duration reached through a call (`Date.now() - ttlFor(x)`) is missed.
 *   • A NEW invalidation helper is exempt only once added to INVALIDATION_FUNCTIONS by hand — which is
 *     the point: adding a name there is a deliberate, reviewable act.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * `Date.now() - …<SOMETHING>_MS…` — the clock minus a named duration.
 *
 * The `_MS` token must be the SUBTRACTION'S OPERAND, so the character class forbids `< > =` between the
 * minus and it. Without that, `Date.now() - prior.at < EMPTY_CLOBBER_MAX_AGE_MS` matches — an age
 * COMPARISON, the exact thing the discriminator exists to let through. (It did, on the first run.)
 * Newlines are excluded for the same reason: an operand lives on the line its operator does, even when
 * the surrounding statement wraps — which is why this still catches the prettier-wrapped original.
 */
const FABRICATE_RE = /Date\.now\s*\(\s*\)\s*-[^;<>=\n]{0,120}?\b[A-Za-z_][A-Za-z0-9_]*_MS\b/g;

/** Declaration forms, so a match can be attributed to the function it sits in. */
const FN_DECL_RE =
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\(|function)/g;

/**
 * Functions whose JOB is invalidation: they mean "treat this as stale from now on", which is genuinely
 * what a timestamp controls — a different mechanism from "don't trust these bytes".
 */
// `sweepStaleScopedArcCache` (PCCC-7): clock-minus-duration as a DELETION CUTOFF (`computed_at <
// cutoff`), never a written timestamp — the orphan sweep for partition-scoped rows.
const INVALIDATION_FUNCTIONS = new Set(["staleArcCache", "bustTeamTimeline", "purgeTimelineCacheTier", "sweepStaleScopedArcCache"]);

const SCAN = [
  join("lib", "graph", "arcs.ts"),
  join("lib", "graph", "arc-cache.ts"),
  join("lib", "dashboard", "timeline-cache.ts"),
];

/** The function a character offset falls in — the LAST declaration starting before it. */
function fnAt(src: string, offset: number): string {
  let name = "<module>";
  FN_DECL_RE.lastIndex = 0;
  for (const m of src.matchAll(FN_DECL_RE)) {
    if (m.index === undefined || m.index > offset) break;
    name = m[1] ?? m[2] ?? name;
  }
  return name;
}

/** Offenders in one source string, attributed by offset (works across wrapped/multi-line shapes). */
export function fabricationsIn(src: string, label = "src"): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(FABRICATE_RE)) {
    const fn = fnAt(src, m.index ?? 0);
    if (INVALIDATION_FUNCTIONS.has(fn)) continue;
    hits.push(`${label}:${fn}: ${m[0].replace(/\s+/g, " ").slice(0, 100)}`);
  }
  return hits;
}

function offenders(): string[] {
  return [
    ...new Set(SCAN.flatMap((rel) => fabricationsIn(readFileSync(join(ROOT, rel), "utf8"), rel))),
  ].sort();
}

describe("guard: computed_at says when, not whether to trust", () => {
  it("no cache writer fabricates a timestamp by subtracting a duration from the clock", () => {
    expect(
      offenders(),
      `A cache writer is deriving a timestamp from the clock minus a duration. If the goal is "expire ` +
        `this sooner because it isn't trustworthy", set the DEGRADED flag and let arcTtlMs() shorten the ` +
        `window — don't falsify the timestamp:\n${offenders().join("\n")}`
    ).toEqual([]);
  });

  it("is non-vacuous against the REAL historical shapes, not a paraphrase of them", () => {
    // Verbatim from the commit that had the bug. The multi-line wrap and the assign-to-a-local form are
    // exactly what defeated this guard's first version, so they are the fixture.
    const realWriteArcCache = [
      "export async function writeArcCache(db, opts = {}) {",
      "  await db.from('arc_cache').upsert({",
      "        computed_at: new Date(",
      "          opts.retryAfterMs === undefined",
      "            ? Date.now()",
      "            : Date.now() - Math.max(0, ARC_CACHE_TTL_MS - opts.retryAfterMs)",
      "        ).toISOString(),",
      "  });",
      "}",
    ].join("\n");
    expect(fabricationsIn(realWriteArcCache)).toHaveLength(1);
    expect(fabricationsIn(realWriteArcCache)[0]).toContain("writeArcCache");

    const realCommitArcs = [
      "export async function commitArcs(db, next, factsHash, opts = {}) {",
      "  const at = untrustworthy ? Date.now() - (CACHE_TTL_MS - UNTRUSTED_RETRY_AFTER_MS) : Date.now();",
      "  cache.set(key, { arcs: next, at, factsHash });",
      "}",
    ].join("\n");
    expect(fabricationsIn(realCommitArcs)).toHaveLength(1);
    expect(fabricationsIn(realCommitArcs)[0]).toContain("commitArcs");

    // The two legitimate AGE computations from the same file must NOT match — subtracting a timestamp.
    const ages = [
      "  if (prior && prior.arcs.length > 0 && Date.now() - prior.at < EMPTY_CLOBBER_MAX_AGE_MS) {",
      "  const ageMs = Date.now() - prior.at;",
    ].join("\n");
    expect(fabricationsIn(ages)).toEqual([]);

    // The honest writes must not match.
    expect(fabricationsIn("computed_at: new Date().toISOString(),")).toEqual([]);
    expect(fabricationsIn("const at = Date.now();")).toEqual([]);

    // Exemption is per-FUNCTION: `staleArcCache` fabricates legitimately and lives in the SAME FILE as
    // `writeArcCache`, so a file-level allowlist would have exempted the bug itself.
    const sameFile = [
      "export async function writeArcCache(db) {",
      "  const at = Date.now() - (ARC_CACHE_TTL_MS - UNTRUSTED_RETRY_AFTER_MS);",
      "}",
      "export async function staleArcCache(db) {",
      "  const staleAt = new Date(Date.now() - (ARC_CACHE_TTL_MS + 60_000)).toISOString();",
      "}",
    ].join("\n");
    const caught = fabricationsIn(sameFile);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toContain("writeArcCache");

    // And every scanned file exists, so `offenders()` isn't green because a path went stale.
    for (const rel of SCAN) expect(() => readFileSync(join(ROOT, rel), "utf8")).not.toThrow();
  });

  it("the derived TTL reproduces the old backdating's retry window exactly", () => {
    // The refactor's equivalence claim, pinned. Old: written at `now - (TTL - RETRY)`, so it read fresh
    // while `age < TTL` — i.e. for RETRY. New: written at `now`, TTL is RETRY — fresh for RETRY. Same
    // window, honest timestamp. If these diverge, a failed synthesis is either pinned for hours (H12) or
    // recomputed on every page view.
    expect(arcTtlMs(true)).toBe(UNTRUSTED_RETRY_AFTER_MS);
    expect(arcTtlMs(false)).toBe(ARC_CACHE_TTL_MS);
    const oldFreshWindow = ARC_CACHE_TTL_MS - (ARC_CACHE_TTL_MS - UNTRUSTED_RETRY_AFTER_MS);
    expect(arcTtlMs(true)).toBe(oldFreshWindow);
    // And a degraded row must expire well before a healthy one, or the flag buys nothing.
    expect(arcTtlMs(true)).toBeLessThan(arcTtlMs(false) / 10);
  });
});
