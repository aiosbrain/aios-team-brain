import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: the per-repo history window must actually be THREADED into both windowed fetches
 * (AIO-798) — pinning the call site, not the function.
 *
 * The failure this traces to: #452's review found 14 green tests over a new role while deleting the
 * ONE argument that wired it left everything green and the feature doing nothing (recorded as the
 * standing `pin-the-call-site-not-just-the-function` lesson). `resolveRepoHistory` has its own unit
 * tests; all of them stay green if the github import leg stops asking for it. Deleting either
 * threaded argument — or the resolver call — turns THIS red.
 *
 * The optional chaining is part of the pin: `history?.sinceIso` / `history?.days` is what makes an
 * absent entry resolve to `undefined` and land on today's defaults (the existing-behaviour pin's
 * other half; the unit tests cover the resolver's null, this covers the importer consuming it).
 */
describe("repo-history threading (AIO-798)", () => {
  const run = readFileSync(join(process.cwd(), "lib/ingest/run.ts"), "utf8");

  it("the github import leg resolves the stored entry once per repo", () => {
    expect(run).toMatch(/const history = resolveRepoHistory\(integ\.config, full\)/);
  });

  it("issues are fetched with the STORED anchor — verbatim, never recomputed", () => {
    expect(run).toMatch(/fetchGithubRepoIssues\(\{[^}]*sinceIso: history\?\.sinceIso/);
    // A recomputed anchor is the sliding window that diff-deletes imported issues: the github leg
    // must not derive a since-time from the clock. (`Date.now` elsewhere in the file is fine — the
    // pin is on the issues call carrying the stored value, and on no new-Date near it.)
    expect(run).not.toMatch(/sinceIso:\s*new Date\(/);
  });

  it("the commit scan gets the chosen window, explicit even at 0", () => {
    expect(run).toMatch(/ingestGithubApiScan\(db, auth, \{[^}]*windowDays: history\?\.days/);
  });
});
