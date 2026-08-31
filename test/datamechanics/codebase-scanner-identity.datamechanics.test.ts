import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseDetail, getCodebaseSummaries } from "@/lib/metrics/codebases";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { MIN_SCANNER_VERSION } from "@/lib/codebases/scanner-version";
import { db, seedTeam } from "./helpers";
import { fullMetrics } from "@/test/fixtures/codebase-scan";

// Spec (brain-api 1.24 / AIO-1011): a scan declares WHICH SCANNER BUILD produced it, via two
// optional nullable fields on `metrics`, and the brain reads back a `current`/`stale`/`unknown`
// verdict.
//
// The bug this closes is a persistence-shaped one, which is why it is proven here and not only in
// the unit tier: 1.22's coverage denominator shipped to seven repos whose pinned scanner could not
// send it, every scan returned 200, and NOTHING in the stored row distinguished "old scanner" from
// "current scanner with nothing to report". So the question is not "does a value round-trip" but
// "does an ABSENT value stay absent — all the way to the surfaces — without ever becoming a
// zero, an empty string, or a false 'current'". `fake-supabase` has no columns and no constraints,
// so only the real-Postgres tier can answer that. This test also exercises the new columns from
// `postgres/migrations/20260831120000_code_metrics_scanner_identity.sql`, so a migration that did
// not load fails here rather than in production.

function scan(slug: string, metrics: Record<string, unknown> = {}) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: fullMetrics({
      head_sha: randomUUID().replace(/-/g, "") + "0".repeat(8),
      ...metrics,
    }),
    contributions: [],
    issues: [],
  });
}

async function push(
  seed: { teamId: string; memberId: string },
  payload: ReturnType<typeof scan>,
) {
  return ingestCodebaseScan(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    payload,
  );
}

async function summaryFor(teamId: string, slug: string) {
  const { codebases } = await getCodebaseSummaries(db(), teamId, "90d", "team");
  return codebases.find((c) => c.slug === slug);
}

describe("scanner identity persistence + the three states (real Postgres)", () => {
  it("CURRENT: a scan declaring a build at the contract minimum round-trips and is not flagged", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await push(
      seed,
      scan(slug, {
        scanner_version: MIN_SCANNER_VERSION,
        scanner_sha: "dd42bf421d436bf1a8993ab62f79d35e4ad63b0a",
      }),
    );

    const summary = await summaryFor(seed.teamId, slug);
    expect(summary?.scanner_version).toBe(MIN_SCANNER_VERSION);
    expect(summary?.scanner_staleness).toBe("current");

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.scanner_version).toBe(MIN_SCANNER_VERSION);
    // Provenance survives the round trip verbatim — it is what locates the pin to bump.
    expect(detail?.breakdown?.scanner_sha).toBe(
      "dd42bf421d436bf1a8993ab62f79d35e4ad63b0a",
    );
    expect(detail?.breakdown?.scanner_staleness).toBe("current");
  });

  it("STALE: a scan declaring a build below the minimum reads back stale, and still ingests fully", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    // The literal shape of the incident: an old scanner that could not send the 1.22 denominator.
    const result = await push(
      seed,
      scan(slug, {
        scanner_version: "0.1.0",
        test_coverage_pct: 99,
        test_coverage_lines_total: null,
      }),
    );
    // A stale scanner is NEVER a reason to reject: the scan lands, whole. A 422 would drop the
    // repo's metrics, findings, contributions and issues, and return before the ingest run is
    // even recorded — so the failure would not appear anywhere at all.
    expect(result).toBeTruthy();

    const summary = await summaryFor(seed.teamId, slug);
    expect(summary?.scanner_version).toBe("0.1.0");
    expect(summary?.scanner_staleness).toBe("stale");
    // ...and the coverage number it could not scope is still there, now with an attributable cause
    // instead of an unexplained blank.
    expect(summary?.test_coverage_pct).toBe(99);
    expect(summary?.test_coverage_lines_total).toBeNull();
  });

  it("UNKNOWN: a scan sending NO identity stores null and reads unknown — never zero, never current", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    // Exactly a pre-1.24 payload: the keys are absent from the wire entirely.
    await push(seed, scan(slug));

    // The stored value is NULL, not "" and not "0.0.0". This is the assertion that would have
    // caught the whole class of bug: an absent declaration must stay absent in the row.
    const raw = await db()
      .from("code_metrics")
      .select("scanner_version, scanner_sha")
      .eq("team_id", seed.teamId)
      .limit(1);
    const row = (raw.data ?? [])[0] as {
      scanner_version: string | null;
      scanner_sha: string | null;
    };
    expect(row.scanner_version).toBeNull();
    expect(row.scanner_sha).toBeNull();

    const summary = await summaryFor(seed.teamId, slug);
    expect(summary?.scanner_version).toBeNull();
    expect(summary?.scanner_staleness).toBe("unknown");
    expect(summary?.scanner_staleness).not.toBe("current");
  });

  it("THE ABSENCE CASE IS DISTINGUISHABLE from both other states, in one team, at once", async () => {
    // The property the feature exists to produce, measured directly: three repos scanned into the
    // same team, differing ONLY in what their scanner declared, must read back as three different
    // states. If staleness detection had silently failed, all three would agree — which is exactly
    // what the fleet looked like before this change.
    const seed = await seedTeam();
    const current = `repo-cur-${randomUUID().slice(0, 6)}`;
    const stale = `repo-old-${randomUUID().slice(0, 6)}`;
    const unknown = `repo-unk-${randomUUID().slice(0, 6)}`;

    await push(seed, scan(current, { scanner_version: "0.9.0" }));
    await push(seed, scan(stale, { scanner_version: "0.1.0" }));
    await push(seed, scan(unknown));

    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    const state = (slug: string) =>
      codebases.find((c) => c.slug === slug)?.scanner_staleness;

    expect(state(current)).toBe("current");
    expect(state(stale)).toBe("stale");
    expect(state(unknown)).toBe("unknown");
    // Non-vacuous: three distinct readings, not one value repeated.
    expect(new Set([state(current), state(stale), state(unknown)]).size).toBe(3);
  });

  it("an UNPARSEABLE version is stored verbatim and read as unknown — never rejected, never current", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    // A CI job that interpolated a branch name instead of a version. Provenance is most valuable
    // exactly when something is wrong with it, so the string is kept; the verdict is unknown.
    await push(seed, scan(slug, { scanner_version: "nightly", scanner_sha: "HEAD" }));

    const summary = await summaryFor(seed.teamId, slug);
    expect(summary?.scanner_version).toBe("nightly");
    expect(summary?.scanner_staleness).toBe("unknown");
  });

  it("the coverage KPI hint names the cause WITHOUT calling an unknown scanner 'stale'", async () => {
    // Day one of 1.24, essentially every repo is on a pre-1.24 scanner sending no identity at
    // all — so `unknown` is the overwhelmingly common state, and whatever word the KPI uses is
    // the word shown for the whole fleet. Calling that union "stale" would assert something
    // false: these repos did not declare an old build, they declared nothing. The aggregate may
    // only claim what it can support ("not current"); the per-repo badge is where the two states
    // are told apart.
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    // Unscoped coverage (a percentage with no denominator) + no scanner identity: the exact
    // fleet state that made 1.22 look like a transient blank for weeks.
    await push(
      seed,
      scan(slug, { test_coverage_pct: 99, test_coverage_lines_total: null }),
    );

    const { codebases, kpis } = await getCodebaseSummaries(
      db(),
      seed.teamId,
      "90d",
      "team",
    );
    expect(codebases.find((c) => c.slug === slug)?.scanner_staleness).toBe(
      "unknown",
    );

    const coverage = kpis.find((k) => k.key === "coverage");
    expect(coverage?.hint).toContain("without scope");
    // The cause is named...
    expect(coverage?.hint).toContain("scanner not current");
    // ...but an unknown build is NOT reported as a stale one.
    expect(coverage?.hint).not.toMatch(/stale/i);
  });

  it("re-scanning with a NEWER scanner moves the repo out of stale (the remedy actually works)", async () => {
    // Without this, "stale" could be a label that never clears — and an alert that cannot be
    // resolved is one people learn to ignore, which is how the original silence started.
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;

    await push(seed, scan(slug, { scanner_version: "0.1.0" }));
    expect((await summaryFor(seed.teamId, slug))?.scanner_staleness).toBe("stale");

    // A later scan, from a bumped pin. `code_metrics` is keyed by (codebase_id, head_sha), so this
    // is a NEW point, and the summary reads the latest.
    await push(
      seed,
      scan(slug, {
        scanner_version: "0.3.0",
        scanned_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const after = await summaryFor(seed.teamId, slug);
    expect(after?.scanner_version).toBe("0.3.0");
    expect(after?.scanner_staleness).toBe("current");
  });
});
