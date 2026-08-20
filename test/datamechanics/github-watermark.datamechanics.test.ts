import { describe, expect, it, vi } from "vitest";
import { db, seedTeam } from "./helpers";
import { linkGithubRepo, unlinkGithubRepo } from "@/lib/integrations/github-link";
import { githubCursorKey, readConnectorCursor, writeConnectorCursor } from "@/lib/ingest/cursors";

// TICKFIT-1 AC1/AC2 (docs/design/tickfit1-github-watermark.md): the probe-first watermark on
// real Postgres with the GitHub API stubbed — the vacuity pin (a quiet second tick actually
// SKIPS the deep legs with zero deep calls), the not-watermarked contracts (issues + the
// scan's metadata leg still run), every bust direction, fail-toward-freshness on probe error,
// no cursor advance on a failed pass, force, the verbatim issues window, and cursor lifecycle.

const gh = vi.hoisted(() => ({
  probe: { pushedAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T01:00:00Z", defaultBranch: "main" },
  probeError: false,
  filesError: false,
  calls: { probe: 0, issues: 0, files: 0, scan: 0 },
  issuesSince: [] as (string | undefined)[],
  scanSkipCommits: [] as (boolean | undefined)[],
}));

vi.mock("@/lib/ingest/sources/github", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    fetchGithubRepoProbe: async () => {
      gh.calls.probe++;
      if (gh.probeError) throw new Error("probe down");
      return { ...gh.probe };
    },
    fetchGithubRepoIssues: async (o: { owner: string; repo: string; sinceIso?: string }) => {
      gh.calls.issues++;
      gh.issuesSince.push(o.sinceIso);
      return { owner: o.owner, repo: o.repo, issues: [] };
    },
  };
});
vi.mock("@/lib/ingest/sources/github-files", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    fetchGithubRepoFiles: async (o: { owner: string; repo: string }) => {
      gh.calls.files++;
      if (gh.filesError) throw new Error("files down");
      return { owner: o.owner, repo: o.repo, files: [] };
    },
  };
});
vi.mock("@/lib/codebases/github-api-scan", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    ingestGithubApiScan: async (_db: unknown, _auth: unknown, params: { skipCommits?: boolean }) => {
      gh.calls.scan++;
      gh.scanSkipCommits.push(params.skipCommits);
      return { codebase_id: "stub", contributions: 0 };
    },
  };
});

async function run(teamId: string, force = false) {
  const { runGithubIngestion } = await import("@/lib/ingest/run");
  return runGithubIngestion({ teamId, force });
}

const snap = () => ({ ...gh.calls });

describe("TICKFIT-1 — the github change watermark (real Postgres, stubbed GitHub)", () => {
  it("tick 2 SKIPS the deep legs (vacuity pin) while issues + the scan still run; busts on push/branch/config/identity/error; force bypasses; a failed pass never advances the cursor; the issues window is the STORED anchor verbatim", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    await linkGithubRepo(db(), auth, "acme/api");
    // A stored history anchor — the issues pass must receive EXACTLY this, every tick (D3).
    const anchor = "2026-07-01T00:00:00.000Z";
    const { data: integ } = await db().from("integrations").select("id, config").eq("team_id", seed.teamId).eq("type", "github").single();
    await db().from("integrations").update({ config: { ...(integ!.config as Record<string, unknown>), repoHistory: [{ repo: "acme/api", days: 30, sinceIso: anchor }] } }).eq("id", integ!.id);

    // Tick 1 — cold: full pass, cursor written.
    const s1 = await run(seed.teamId);
    expect(s1.errors).toEqual([]);
    expect(snap()).toEqual({ probe: 1, issues: 1, files: 1, scan: 1 });
    expect(gh.scanSkipCommits.at(-1), "tick 1 paginates commits").toBe(false);
    const key = githubCursorKey("acme", "api");
    const c1 = await readConnectorCursor(db(), seed.teamId, key);
    expect(c1?.pushedAt).toBe(gh.probe.pushedAt);

    // Tick 2 — quiet: the deep legs SKIP (files not called again; the scan runs but skips
    // commits); issues STILL runs (deliberately not watermarked); the skip is reported.
    const s2 = await run(seed.teamId);
    expect(s2.skippedRepos).toEqual(["acme/api"]);
    expect(snap()).toEqual({ probe: 2, issues: 2, files: 1, scan: 2 });
    expect(gh.scanSkipCommits.at(-1), "tick 2's scan is metadata-only").toBe(true);
    expect(s2.unchanged, "a skip is NOT counted as unchanged (nothing was diff-synced by the deep legs)").toBeLessThanOrEqual(1); // the issues container item only

    // Bust 1 — a push: full pass again, cursor advances.
    gh.probe = { ...gh.probe, pushedAt: "2026-08-20T02:00:00Z" };
    const s3 = await run(seed.teamId);
    expect(s3.skippedRepos).toEqual([]);
    expect(snap()).toEqual({ probe: 3, issues: 3, files: 2, scan: 3 });
    expect((await readConnectorCursor(db(), seed.teamId, key))?.pushedAt).toBe("2026-08-20T02:00:00Z");

    // Bust 2 — a default-branch switch at EQUAL pushed_at.
    gh.probe = { ...gh.probe, defaultBranch: "develop" };
    await run(seed.teamId);
    expect(gh.calls.files, "branch switch full-passes").toBe(3);

    // Quiet again → skip.
    await run(seed.teamId);
    expect(gh.calls.files).toBe(3);

    // Bust 3 — a config change (fileGlobs) despite equal remote values.
    const { data: integ2 } = await db().from("integrations").select("id, config").eq("team_id", seed.teamId).eq("type", "github").single();
    await db().from("integrations").update({ config: { ...(integ2!.config as Record<string, unknown>), fileGlobs: ["docs/**"] } }).eq("id", integ2!.id);
    await run(seed.teamId);
    expect(gh.calls.files, "a glob change busts the cursor").toBe(4);

    // Bust 4 — an identity change (a new member joins the identity map).
    await run(seed.teamId); // converge → skip state
    const filesAfterConverge = gh.calls.files;
    await db().from("members").insert({ team_id: seed.teamId, email: "new-dev@t.local", display_name: "N", actor_handle: "new-dev", role: "member", tier: "team", status: "active" });
    await run(seed.teamId);
    expect(gh.calls.files, "an identity-map change busts the cursor (files/commits attribute at scan time)").toBe(filesAfterConverge + 1);

    // Fail-toward-freshness: a probe ERROR runs the full pass.
    await run(seed.teamId); // converge
    const filesBeforeErr = gh.calls.files;
    gh.probeError = true;
    const sErr = await run(seed.teamId);
    expect(sErr.skippedRepos).toEqual([]);
    expect(gh.calls.files, "probe down → full pass, never a stale skip").toBe(filesBeforeErr + 1);
    gh.probeError = false;

    // A FAILED pass never advances the cursor: bump the remote, make files fail → next tick
    // still full-passes (the delta is not orphaned behind an advanced cursor).
    gh.probe = { ...gh.probe, pushedAt: "2026-08-20T03:00:00Z" };
    gh.filesError = true;
    const sFail = await run(seed.teamId);
    expect(sFail.errors.length).toBeGreaterThan(0);
    expect((await readConnectorCursor(db(), seed.teamId, key))?.pushedAt, "failed pass → cursor NOT advanced").not.toBe("2026-08-20T03:00:00Z");
    gh.filesError = false;
    const filesBeforeRetry = gh.calls.files;
    await run(seed.teamId);
    expect(gh.calls.files, "the retry full-passes and completes").toBe(filesBeforeRetry + 1);
    expect((await readConnectorCursor(db(), seed.teamId, key))?.pushedAt).toBe("2026-08-20T03:00:00Z");

    // force: true bypasses the watermark despite an equal cursor (the manual-sync promise).
    const filesBeforeForce = gh.calls.files;
    const sForce = await run(seed.teamId, true);
    expect(sForce.skippedRepos).toEqual([]);
    expect(gh.calls.files).toBe(filesBeforeForce + 1);

    // D3: EVERY issues call received the stored anchor verbatim — the watermark never touches
    // the window.
    expect(gh.issuesSince.every((s) => s === anchor), `issues windows seen: ${[...new Set(gh.issuesSince)].join(",")}`).toBe(true);

    // D2e lifecycle: unlink deletes the cursor row.
    await unlinkGithubRepo(db(), auth, "acme/api");
    expect(await readConnectorCursor(db(), seed.teamId, key)).toBeNull();
  });

  it("the real scan's skipCommits leg: metadata upserts both ways, contributions only on a full pass (global-fetch stub, real Postgres)", async () => {
    const seed = await seedTeam();
    const { ingestGithubApiScan: realScan } = (await vi.importActual("@/lib/codebases/github-api-scan")) as {
      ingestGithubApiScan: (db: unknown, auth: unknown, params: Record<string, unknown>) => Promise<{ contributions: number }>;
    };
    const commitCalls = { n: 0 };
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL) => {
      const u = String(url);
      const body = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/languages")) return body({ TypeScript: 100 });
      if (u.includes("/commits")) {
        commitCalls.n++;
        return body([{ sha: "a1", commit: { author: { name: "Dev", email: "dev@t.local", date: "2026-08-19T00:00:00Z" }, message: "m" }, author: { login: "dev" } }]);
      }
      return body({ full_name: "acme/api", default_branch: "main", description: "d", homepage: "", language: "TypeScript", stargazers_count: 1, forks_count: 0, open_issues_count: 0, archived: false });
    }) as typeof fetch);
    try {
      const auth = { teamId: seed.teamId, memberId: seed.memberId };
      const skipped = await realScan(db(), auth, { owner: "acme", repo: "api", slug: "api", token: "", skipCommits: true });
      expect(commitCalls.n, "skipCommits never paginates commits").toBe(0);
      expect(skipped.contributions).toBe(0);
      const { data: cb } = await db().from("codebases").select("stars, languages").eq("team_id", seed.teamId).eq("slug", "api").single();
      expect(cb!.stars, "the metadata leg still upserted").toBe(1);

      await realScan(db(), auth, { owner: "acme", repo: "api", slug: "api", token: "", skipCommits: false });
      expect(commitCalls.n, "a full pass paginates").toBeGreaterThan(0);
      const { data: contrib } = await db().from("code_contributions").select("id").eq("team_id", seed.teamId);
      expect((contrib ?? []).length, "contributions written only by the full pass").toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cursor store plumbing: single round-trip, verbatim values, team-scoped", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const w = await writeConnectorCursor(db(), seed.teamId, "github:a/b", { pushedAt: "X", configHash: "h" });
    expect(w.ok).toBe(true);
    expect(await readConnectorCursor(db(), seed.teamId, "github:a/b")).toEqual({ pushedAt: "X", configHash: "h" });
    expect(await readConnectorCursor(db(), other.teamId, "github:a/b"), "cursors are team-scoped").toBeNull();
  });
});
