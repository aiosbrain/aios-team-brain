import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db/types";
import { visibleTierGroupIds, builtinTierGroupId } from "@/lib/graph/tier-groups";

/**
 * The reader half of the rename doctrine (see lib/graph/tier-groups.ts). These are the PURE mapping
 * rules — which built-in owns which tier, pointer-wins-over-slug, the unbootstrapped fallback, and
 * the tier fence. The real-Postgres proof that a renamed team still reads its own graph, and that
 * the `team_id` scope is what stops a cross-team resolve, lives in the data-mechanics tier
 * (test/datamechanics/graph-rename-read-pointer.datamechanics.test.ts) — CLAUDE.md §4: access is a
 * persistence outcome, not a call-site reading.
 */

type Row = { slug: string; graph_group_id: string };

/**
 * Table-aware double: `projects` serves the built-in pointers, `graph_episodes` serves the
 * foreign-history ledger the fallback path consults. Filters are recorded so the call contract
 * (team scope, kind scope) can be pinned.
 */
function fakeDb(
  rows: Row[],
  opts: { error?: string; seen?: Record<string, string>; foreign?: string[] } = {}
): DbClient {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const record = (k: string, v: unknown) => {
        if (opts.seen) opts.seen[k] = `${v}`;
        return chain;
      };
      chain.select = () => chain;
      chain.eq = (col: string, val: unknown) => record(`${table}.${col}`, val);
      chain.neq = (col: string, val: unknown) => record(`${table}.neq.${col}`, val);
      chain.in = (col: string, val: unknown) => record(`${table}.in.${col}`, JSON.stringify(val));
      chain.not = () => chain;
      chain.limit = () => chain;
      chain.then = (resolve: (r: unknown) => unknown) => {
        if (opts.error) return resolve({ data: null, error: { message: opts.error } });
        if (table === "graph_episodes") {
          return resolve({ data: (opts.foreign ?? []).map((g) => ({ group_id: g })), error: null });
        }
        return resolve({ data: rows, error: null });
      };
      return chain;
    },
  } as unknown as DbClient;
}

const GENERAL: Row = { slug: "general", graph_group_id: "oldslug_team" };
const EXTERNAL: Row = { slug: "external-shared", graph_group_id: "oldslug_external" };
const ARGS = { teamId: "11111111-1111-4111-8111-111111111111", teamSlug: "newslug" } as const;

describe("visibleTierGroupIds — the pointer-resolved tier read set", () => {
  it("follows the FROZEN pointers, not the live slug (the rename regression)", async () => {
    // The exact 2026-08-18 failure: the team is now `newslug`, the projector still writes the
    // pointers minted under `oldslug`. A slug-derived reader searched `newslug_team` — a group
    // nothing has ever written to — and the panel went permanently, silently empty.
    expect(await visibleTierGroupIds(fakeDb([GENERAL, EXTERNAL]), { ...ARGS, tier: "team" })).toEqual([
      "oldslug_team",
      "oldslug_external",
    ]);
  });

  it("an external viewer resolves ONLY the external-shared pointer (no team leak)", async () => {
    // The tier fence, post-fix: it is PROJECT IDENTITY (`slug = external-shared`), not the `_external`
    // string suffix. Pinned with a General pointer present and deliberately team-shaped — if the
    // resolution ever keyed on the suffix instead of the built-in, this returns the team group.
    expect(await visibleTierGroupIds(fakeDb([GENERAL, EXTERNAL]), { ...ARGS, tier: "external" })).toEqual([
      "oldslug_external",
    ]);
  });

  it("falls back to the slug-derived mint for an UNBOOTSTRAPPED team — the same fallback the projector takes", async () => {
    // Reader and writer must agree in BOTH states. lib/graph/project.ts falls back to
    // episodeGroupId when a team has no pointers; if the reader threw or returned [] here it would
    // disagree with the projector for exactly the teams that have never bootstrapped.
    expect(await visibleTierGroupIds(fakeDb([]), { ...ARGS, tier: "team" })).toEqual([
      "newslug_team",
      "newslug_external",
    ]);
    expect(await visibleTierGroupIds(fakeDb([]), { ...ARGS, tier: "external" })).toEqual(["newslug_external"]);
  });

  it("falls back PER BUILT-IN — a half-bootstrapped team keeps the pointer it does have", async () => {
    expect(await visibleTierGroupIds(fakeDb([GENERAL]), { ...ARGS, tier: "team" })).toEqual([
      "oldslug_team",
      "newslug_external",
    ]);
  });

  it("scopes the pointer read to THIS team and to the system built-ins", async () => {
    // The `team_id` filter is the whole cross-team guarantee (there is no RLS backstop, CLAUDE.md
    // §5) — an unscoped read could hand a renamed team another team's frozen partition. Pinned
    // here as a call contract; proven against real Postgres in the data-mechanics tier.
    const seen: Record<string, string> = {};
    await visibleTierGroupIds(fakeDb([GENERAL, EXTERNAL], { seen }), { ...ARGS, tier: "team" });
    expect(seen["projects.team_id"]).toBe(ARGS.teamId);
    expect(seen["projects.kind"]).toBe("system");
  });

  it("THROWS on a pointer read failure — it must never fall back to the slug", async () => {
    // A swallowed error that degraded to the slug-derived id would silently reinstate the exact
    // defect this module closes, on the one team most likely to hit it. Callers that can degrade
    // catch this and say so; none of them guess.
    await expect(visibleTierGroupIds(fakeDb([], { error: "boom" }), { ...ARGS, tier: "team" })).rejects.toThrow(
      /built-in pointer read failed/
    );
  });

  it("dedupes — a duplicated group id in a /search call is pure waste", async () => {
    // A non-`_team`-suffixed value, so this pins DEDUPE and not the direction check below.
    const shared = [
      { slug: "general", graph_group_id: "shared_partition" },
      { slug: "external-shared", graph_group_id: "shared_partition" },
    ];
    expect(await visibleTierGroupIds(fakeDb(shared), { ...ARGS, tier: "team" })).toEqual(["shared_partition"]);
  });
});

describe("builtinTierGroupId — the single access-tier → partition mapping", () => {
  it("maps team → General's pointer and external → external-shared's", async () => {
    const db = fakeDb([GENERAL, EXTERNAL]);
    expect(await builtinTierGroupId(db, { ...ARGS, access: "team" })).toBe("oldslug_team");
    expect(await builtinTierGroupId(db, { ...ARGS, access: "external" })).toBe("oldslug_external");
  });

  it("falls back to the mint when the built-in has no pointer", async () => {
    expect(await builtinTierGroupId(fakeDb([]), { ...ARGS, access: "team" })).toBe("newslug_team");
  });
});

describe("the fallback is FENCED — it is the one path still keyed on a slug", () => {
  // Review High 1, and the state that actually reaches it: team A renames off `newslug`, team B is
  // CREATED on it, and B's bootstrap hits project-pointer.ts's foreign-history refusal — which
  // returns BEFORE filling, so B's built-ins keep graph_group_id = NULL forever (lib/admin/teams.ts
  // swallows the bootstrap result; every scheduler tick re-refuses). Unfenced, B's readers resolve
  // `newslug_team` — team A's live partition — and are served it with no error anywhere.
  it("REFUSES a slug-derived group whose episode history belongs to another team", async () => {
    await expect(
      visibleTierGroupIds(fakeDb([], { foreign: ["newslug_team"] }), { ...ARGS, tier: "team" })
    ).rejects.toThrow(/holds ANOTHER team's episode history/);
  });

  it("refuses on the single-group write path too", async () => {
    await expect(
      builtinTierGroupId(fakeDb([], { foreign: ["newslug_team"] }), { ...ARGS, access: "team" })
    ).rejects.toThrow(/holds ANOTHER team's episode history/);
  });

  it("checks the ledger scoped to the fallback ids and EXCLUDING this team", async () => {
    const seen: Record<string, string> = {};
    await visibleTierGroupIds(fakeDb([], { seen }), { ...ARGS, tier: "team" });
    expect(seen["graph_episodes.in.group_id"]).toBe(JSON.stringify(["newslug_team", "newslug_external"]));
    expect(seen["graph_episodes.neq.team_id"]).toBe(ARGS.teamId);
  });

  it("does NOT consult the ledger when every built-in is pointed — a pointed team pays nothing", async () => {
    const seen: Record<string, string> = {};
    await visibleTierGroupIds(fakeDb([GENERAL, EXTERNAL], { seen }), { ...ARGS, tier: "team" });
    expect(Object.keys(seen).some((k) => k.startsWith("graph_episodes."))).toBe(false);
  });

  it("a foreign-history READ failure throws — it must not degrade into reading the group anyway", async () => {
    await expect(
      visibleTierGroupIds(fakeDb([], { error: "boom" }), { ...ARGS, tier: "team" })
    ).rejects.toThrow(/pointer read failed|foreign-history check failed/);
  });
});

describe("the direction check — an external read never yields a team group", () => {
  // Review Medium 1: project-pointer.ts verifies a set built-in pointer's SHAPE only, so an
  // external-shared pointer holding a `_team` id passes verification. Before this module that
  // corruption was inert on reads; now it would not be. group_id is the sole tier fence (§5).
  it("refuses a `_team`-suffixed id resolved for the external tier", async () => {
    const corrupt = [{ slug: "external-shared", graph_group_id: "oldslug_team" }];
    await expect(visibleTierGroupIds(fakeDb(corrupt), { ...ARGS, tier: "external" })).rejects.toThrow(
      /resolved to "oldslug_team", a TEAM group/
    );
  });

  it("does NOT refuse a per-project mint — a built-in may legitimately hold one", async () => {
    // Deliberately narrow: demanding an `_external` suffix would throw on this legitimate value.
    const minted = [{ slug: "external-shared", graph_group_id: "g_deadbeef_p_cafebabe" }];
    expect(await visibleTierGroupIds(fakeDb(minted), { ...ARGS, tier: "external" })).toEqual([
      "g_deadbeef_p_cafebabe",
    ]);
  });
});
