import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseDetail, getCodebaseSummaries } from "@/lib/metrics/codebases";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";
import { fullMetrics } from "@/test/fixtures/codebase-scan";

// Spec (brain-api 1.22 / AIO-995): `test_coverage_pct` must arrive with the denominator it was
// measured over, and a run that skipped or failed cases must announce itself. These are seven new
// NULLABLE columns on `code_metrics` — a table full of rows that will never have values for them —
// so the persistence question is not "does a value round-trip" but "does an ABSENT value stay
// absent, all the way to the surfaces, without ever becoming a zero". `fake-supabase` has no
// columns, constraints, or numeric coercion, so only the real-Postgres tier can answer that.

function scan(slug: string, metrics: Record<string, unknown> = {}) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: fullMetrics({ head_sha: randomUUID().replace(/-/g, "") + "0".repeat(8), ...metrics }),
    contributions: [],
    issues: [],
  });
}

async function push(seed: { teamId: string; memberId: string }, payload: ReturnType<typeof scan>) {
  return ingestCodebaseScan(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    payload
  );
}

describe("coverage denominator + run integrity persistence (real Postgres)", () => {
  it("round-trips the denominator and derives breadth against loc", async () => {
    const seed = await seedTeam();
    const slug = `repo-${randomUUID().slice(0, 6)}`;

    await push(
      seed,
      scan(slug, {
        loc: 3_140,
        test_coverage_pct: 99,
        test_coverage_lines_total: 436,
        test_coverage_lines_covered: 432,
        tests_total: 40,
        tests_passed: 40,
        tests_skipped: 0,
        tests_failed: 0,
      })
    );

    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    const summary = codebases.find((c) => c.slug === slug);
    expect(summary?.test_coverage_pct).toBe(99);
    expect(summary?.test_coverage_lines_total).toBe(436);
    expect(summary?.loc).toBe(3_140);
    // 436 / 3,140 — the scope the 99% actually speaks for. numeric(5,2) round-trips as a string
    // through the pg adapter, so this also pins the coercion (#134 gotcha).
    expect(summary?.coverage_breadth_pct).toBe(13.89);
    expect(summary?.scan_partial).toBe(false);

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.test_coverage_lines_total).toBe(436);
    expect(detail?.breakdown?.test_coverage_lines_covered).toBe(432);
    expect(detail?.breakdown?.coverage_breadth_pct).toBe(13.89);
    expect(detail?.breakdown?.loc).toBe(3_140);
  });

  it("two repos with the SAME coverage % and different denominators are distinguishable in the DB", async () => {
    // The failure this issue is about: before 1.22 these two rows were byte-identical on every
    // coverage-bearing column, so no surface could rank or caveat them differently.
    const seed = await seedTeam();
    const narrow = `narrow-${randomUUID().slice(0, 6)}`;
    const broad = `broad-${randomUUID().slice(0, 6)}`;

    await push(seed, scan(narrow, { loc: 3_140, test_coverage_pct: 99, test_coverage_lines_total: 436 }));
    await push(seed, scan(broad, { loc: 11_000, test_coverage_pct: 99, test_coverage_lines_total: 10_647 }));

    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    const a = codebases.find((c) => c.slug === narrow);
    const b = codebases.find((c) => c.slug === broad);

    expect(a?.test_coverage_pct).toBe(b?.test_coverage_pct);
    expect(a?.coverage_breadth_pct).toBe(13.89);
    expect(b?.coverage_breadth_pct).toBe(96.79);

    // …and the composites are, for now, deliberately identical: breadth is disclosed, not scored.
    // If this line ever needs changing, that is the moment to update score.ts's comment too.
    expect(a?.health_score).toBe(b?.health_score);
  });

  it("BACKWARD COMPAT: a pre-1.22 payload writes NULLs, and reads back as unknown — never zero", async () => {
    const seed = await seedTeam();
    const slug = `legacy-${randomUUID().slice(0, 6)}`;

    // `fullMetrics` is the pre-1.22 block: it names none of the six new fields. This is exactly
    // what a scanner that hasn't been upgraded still sends.
    await push(seed, scan(slug, { test_coverage_pct: 77.68 }));

    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    const summary = codebases.find((c) => c.slug === slug);
    expect(summary?.test_coverage_pct).toBe(77.68);
    expect(summary?.test_coverage_lines_total).toBeNull();
    expect(summary?.coverage_breadth_pct).toBeNull();
    // No test-result report means completeness is UNKNOWN. `false` here would be the brain
    // asserting "nothing was skipped" on evidence it does not have.
    expect(summary?.scan_partial).toBeNull();

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.coverage_breadth_pct).toBeNull();
    expect(detail?.breakdown?.tests_skipped).toBeNull();
    expect(detail?.breakdown?.scan_partial).toBeNull();
    // And the scores it did compute are untouched by the new columns' absence.
    expect(detail?.breakdown?.test_coverage_score).toBe(97.1); // clamp((77.68/80)*100)
  });

  it("a scan with skipped or failed cases is flagged partial on both surfaces", async () => {
    const seed = await seedTeam();
    const slug = `partial-${randomUUID().slice(0, 6)}`;

    // The aios-devtools shape: one unset env var, 91 of 229 tests skipped by design, coverage
    // 29 points adrift, and nothing red.
    await push(
      seed,
      scan(slug, {
        test_coverage_pct: 48.93,
        tests_total: 229,
        tests_passed: 138,
        tests_skipped: 91,
        tests_failed: 0,
      })
    );

    const { codebases } = await getCodebaseSummaries(db(), seed.teamId, "90d", "team");
    expect(codebases.find((c) => c.slug === slug)?.scan_partial).toBe(true);

    const detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.breakdown?.scan_partial).toBe(true);
    expect(detail?.breakdown?.tests_skipped).toBe(91);
    expect(detail?.breakdown?.tests_total).toBe(229);
  });

  it("the DB rejects a negative count — a bad parse can't become permanent analytics", async () => {
    const seed = await seedTeam();
    const slug = `neg-${randomUUID().slice(0, 6)}`;
    // Bypass the zod boundary to prove the CHECK constraint is real and not just wire validation.
    const payload = scan(slug);
    (payload.metrics as Record<string, unknown>).tests_skipped = -1;
    await expect(push(seed, payload)).rejects.toThrow();
  });
});
