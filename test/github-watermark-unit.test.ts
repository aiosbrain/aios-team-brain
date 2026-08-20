import { describe, expect, it } from "vitest";
import { githubRepoConfigHash, shouldSkipGithubRepo, type GithubRepoProbe } from "@/lib/ingest/github-watermark";

// TICKFIT-1 AC3: the pure decision truth table (skip ONLY on full equality) + the
// deterministic hash (a nondeterministic hash would make the watermark silently never skip —
// the round-2 vacuity failure).

const PROBE: GithubRepoProbe = { pushedAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T01:00:00Z", defaultBranch: "main" };
const HASH = "abc123";
const CURSOR = { ...PROBE, configHash: HASH };

describe("shouldSkipGithubRepo — the D2 truth table", () => {
  it("skips ONLY on full equality of all three remote values + the config hash", () => {
    expect(shouldSkipGithubRepo(CURSOR, PROBE, HASH)).toBe(true);
    expect(shouldSkipGithubRepo(null, PROBE, HASH), "absent cursor → full pass").toBe(false);
    expect(shouldSkipGithubRepo(CURSOR, null, HASH), "absent probe → full pass").toBe(false);
    expect(shouldSkipGithubRepo(CURSOR, PROBE, "other"), "config change → full pass").toBe(false);
    expect(shouldSkipGithubRepo(CURSOR, { ...PROBE, pushedAt: "2026-08-20T00:00:01Z" }, HASH), "a push (even a REGRESSION) → full pass").toBe(false);
    expect(shouldSkipGithubRepo(CURSOR, { ...PROBE, updatedAt: "2026-08-21T00:00:00Z" }, HASH), "a settings change → full pass").toBe(false);
    expect(shouldSkipGithubRepo(CURSOR, { ...PROBE, defaultBranch: "develop" }, HASH), "a branch switch at equal pushed_at → full pass").toBe(false);
  });

  it("null-valued remote fields NEVER match (an empty/undeterminable repo always full-passes)", () => {
    const nullProbe = { ...PROBE, pushedAt: null };
    expect(shouldSkipGithubRepo({ ...CURSOR, pushedAt: null }, nullProbe, HASH), "null == null is NOT a match").toBe(false);
    expect(shouldSkipGithubRepo(CURSOR, nullProbe, HASH)).toBe(false);
    expect(shouldSkipGithubRepo({ ...CURSOR, defaultBranch: undefined } as never, PROBE, HASH), "missing stored field → full pass").toBe(false);
  });
});

describe("githubRepoConfigHash — deterministic, and sensitive to every part", () => {
  const base = {
    fileGlobs: ["docs/**", "*.md"],
    historySinceIso: "2026-07-01T00:00:00.000Z",
    historyDays: 30,
    identityEntries: ["email:a@x=m1", "handle:b=m2", "domain:x"],
  };

  it("shuffled-equivalent inputs hash identically (the vacuity guard)", () => {
    const shuffled = {
      ...base,
      fileGlobs: ["*.md", "docs/**"],
      identityEntries: ["domain:x", "email:a@x=m1", "handle:b=m2"],
    };
    expect(githubRepoConfigHash(shuffled)).toBe(githubRepoConfigHash(base));
  });

  it("each part changes the hash (glob, anchor, days, identity)", () => {
    const h = githubRepoConfigHash(base);
    expect(githubRepoConfigHash({ ...base, fileGlobs: ["docs/**"] })).not.toBe(h);
    expect(githubRepoConfigHash({ ...base, historySinceIso: "2026-06-01T00:00:00.000Z" })).not.toBe(h);
    expect(githubRepoConfigHash({ ...base, historyDays: 90 })).not.toBe(h);
    expect(githubRepoConfigHash({ ...base, identityEntries: [...base.identityEntries, "email:new@x=m3"] })).not.toBe(h);
  });
});

describe("fetchGithubRepoProbe — the real parser (Fable diff L2)", () => {
  it("coerces missing/empty fields to null and throws on non-OK", async () => {
    const { fetchGithubRepoProbe } = await import("@/lib/ingest/sources/github");
    const ok = await fetchGithubRepoProbe({
      owner: "a", repo: "b",
      fetchImpl: (async () => new Response(JSON.stringify({ pushed_at: "2026-08-20T00:00:00Z", default_branch: "" }), { status: 200 })) as typeof fetch,
    });
    expect(ok).toEqual({ pushedAt: "2026-08-20T00:00:00Z", updatedAt: null, defaultBranch: null });
    await expect(
      fetchGithubRepoProbe({ owner: "a", repo: "b", fetchImpl: (async () => new Response("nope", { status: 403 })) as typeof fetch })
    ).rejects.toThrow(/probe failed \(403\)/);
  });
});
