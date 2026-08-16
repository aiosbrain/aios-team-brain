import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: the newest-episode probe must ignore ledger rows that POSTed nothing to Graphiti.
 *
 * `lib/graph/project.ts` bumps `projected_at` on two paths that push no episode — the blanking/
 * redaction path and the tier-vacate path — parking both on a `content_sha256 = ''` sentinel. Without
 * the filter, a redaction wave reads as "an episode just landed", no extraction follows it, and six
 * hours later the admin banner calls a perfectly healthy extractor STOPPED. That is the cry-wolf
 * failure this probe exists to avoid, so it must not be the probe's own bug.
 *
 * Pinned as source text because the alternative is a real-Postgres fixture for one SQL predicate.
 */
describe("guard: the lag probe excludes no-POST ledger touches", () => {
  const src = readFileSync(join(process.cwd(), "lib", "graph", "extraction-health.ts"), "utf8");

  it("the ledger read filters out the '' sentinel sha", () => {
    // STALLSCOPE-1 folded the four separate ledger reads into one statement inside `readLedger`, so the
    // anchor moved with them. Anchored on the FUNCTION, not on a bare substring: the file's own prose
    // discusses the sentinel at length, and a looser anchor would match the comments and pass for the
    // wrong reason (the failure mode this repo hit twice — a guard satisfied by a comment about itself).
    const start = src.indexOf("async function readLedger");
    expect(start, "readLedger is gone or was renamed — this guard is stale, not passing").toBeGreaterThan(-1);
    const q = src.slice(start, src.indexOf("\n}", start));
    expect(q).toContain("content_sha256 <> ''");
    // The population that feeds the floor and the scope must be the SAME rows the sentinel excludes.
    expect(q).toContain("count(distinct (source_table, source_id))");
    expect(q).toContain("min(first_seen_at)");
  });

  it("the sentinel is still what the no-POST paths write (or this guard is stale)", () => {
    const proj = readFileSync(join(process.cwd(), "lib", "graph", "project.ts"), "utf8");
    expect(proj).toContain('content_sha256: ""');
  });
});
