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

  it("newestEpisodeAtMs filters out the '' sentinel sha", () => {
    const q = src.slice(src.indexOf("export async function newestEpisodeAtMs"));
    expect(q).toContain("content_sha256 <> ''");
  });

  it("the sentinel is still what the no-POST paths write (or this guard is stale)", () => {
    const proj = readFileSync(join(process.cwd(), "lib", "graph", "project.ts"), "utf8");
    expect(proj).toContain('content_sha256: ""');
  });
});
