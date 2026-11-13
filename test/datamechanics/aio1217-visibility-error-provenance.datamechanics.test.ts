import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { delegatedVisibleItemIds, visibleItemIds } from "@/lib/access/enforce";
import { auditVisibilityAgainstItemIds } from "@/lib/access/inspect";
import { visibleProjects } from "@/lib/access/oracle";
import { PgClient } from "@/lib/db/pg/client";
import { runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { listMeetingNotesForTeam } from "@/lib/meetings/notes";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { db, ingest, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — `visibleItemIds` keeps a resolver read error's provenance (real Postgres): the shared
 * owner, and the callers of it that can be executed as plain functions.
 *
 * The materializer used to read the oracle through `visibleProjects`, which answers a failed
 * `members` / `group_members` / `project_groups` read with the same empty set a grantless principal
 * gets. It now reads `visibleProjectsWithError` and returns that failure as `error`, exactly as it
 * always did for its own `project_context_memberships` read. This file pins, against the
 * specification's "Production caller census and compatibility decision":
 *
 *   O1  the owner, all four legs      a failed read is empty WITH `error`, and resolution stops there;
 *                                     on the three oracle legs (O1b) no project set is returned either.
 *   O2  the owner, no fault           a member's real item set is unflagged; a principal the oracle
 *                                     grants no project is empty WITHOUT `error` and without a grant
 *                                     or item-membership read. The flag is never inferred from
 *                                     emptiness.
 *   O3  what did NOT change           `visibleProjects` still answers a failed oracle read with a plain
 *                                     empty set, and `delegatedVisibleItemIds`, which reads through it,
 *                                     still reports no error on an oracle fault: the disclosed
 *                                     agent-token residual, recorded here and not corrected.
 *   M   lib/meetings/notes.ts         `listMeetingNotesForTeam` rejects on an oracle fault instead of
 *                                     resolving an empty list (changed outcome).
 *   I   lib/access/inspect.ts         `auditVisibilityAgainstItemIds` ignores the flag and reports the
 *                                     item exactly as it did before (unchanged outcome).
 *
 * What is real: the functions named above, the oracle, the query builder, the pg pool and the
 * data-mechanics Postgres. Nothing is stubbed.
 *
 * THE FAULT IS SYNTHETIC. A real `PgClient` is built over an executor that forwards to the real pool
 * `runSql` and rejects, instead of sending, the first SELECT against one named table. The real
 * adapter turns that rejection into its own returned `{ error }` envelope. It is not a native driver
 * failure. Every fault case asserts the fault fired exactly once and that the adapter surfaced it.
 *
 * Bounds of what is claimed.
 *   - M calls the notes reader directly, not `lib/meetings/loaders.ts` or a rendered layout: it shows
 *     the rejection an error boundary would receive, not the boundary.
 *   - I faults `group_members` and `project_groups` only. `auditVisibilityAgainstItemIds` issues its
 *     own `members` read first, so a first-`members` fault would land there and not in the resolver.
 *   - The other callers in the census are not executed here: the evidence-search member-key route,
 *     the Social page, the People page, the dashboard media route and the second draft scope of
 *     `generateDrafts`. The two action exports and one chain-gated export are executed in
 *     `server-action-scope-connections.datamechanics.test.ts`.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired fault case would be vacuous):";

type Row = Record<string, unknown>;

const FAULT_MESSAGE = "aio1217 synthetic resolver read fault";

/** The resolver's reads in the order it issues them: the oracle's three, then the materializer's. */
const ORACLE_LEGS = ["members", "group_members", "project_groups"] as const;
const RESOLVER_LEGS = [...ORACLE_LEGS, "project_context_memberships"] as const;

/** One team, one ingest, one context backfill and a handful of reads per case. */
const ROOMY = 20_000;

// Embedded resources compile to lowercase subselects, so the last uppercase FROM of a SELECT is its
// own table.
const SELECT_HEAD = /^SELECT [\s\S]* FROM ([a-z_]+) /;

interface Trace {
  /** The table of each SELECT the client was asked for, in order, the rejected one included. */
  selects: string[];
  fired: number;
}

/**
 * A real `PgClient` over the real pool that notes each SELECT's table and, when `faultTable` is
 * given, rejects the first SELECT against it in place of sending it.
 */
function tracedDb(faultTable?: string): { client: DbClient; trace: Trace } {
  const trace: Trace = { selects: [], fired: 0 };
  const executor: SqlExecutor = async <T = Row>(text: string, params: unknown[] = []) => {
    const table = SELECT_HEAD.exec(text)?.[1];
    if (table) {
      trace.selects.push(table);
      if (table === faultTable && trace.fired === 0) {
        trace.fired += 1;
        throw new Error(FAULT_MESSAGE);
      }
    }
    return runSql<T>(text, params);
  };
  return { client: new PgClient({ executor }) as unknown as DbClient, trace };
}

/** Run `read` with the first SELECT on `table` rejected; the fault fired once and the adapter surfaced it. */
async function underFault<T>(table: string, read: (client: DbClient) => Promise<T>): Promise<{ result: T; trace: Trace }> {
  const { client, trace } = tracedDb(table);
  // The real adapter logs the failure it converts; captured so the fault can be shown to surface there.
  const adapterLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let logged: string[] = [];
  let result: T;
  try {
    result = await read(client);
  } finally {
    logged = adapterLog.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(FAULT_MESSAGE));
    adapterLog.mockRestore();
  }
  expect(trace.fired, `${FIXTURE} the armed ${table} fault fired exactly once`).toBe(1);
  expect(logged, `${FIXTURE} the real adapter surfaced the fault as its own returned error`).toEqual([
    `[pg] select ${table}: ${FAULT_MESSAGE}`,
  ]);
  return { result, trace };
}

interface World {
  seed: Seed;
  /** A team-access item every Everyone member of the team reaches. */
  itemId: string;
  /** The seed's active human member: Everyone, so granted the team's shared project. */
  member: string;
  /** An active agent holding only a planted Everyone row: a principal the oracle grants nothing. */
  grantless: string;
}

async function seedWorld(): Promise<World> {
  const seed = await seedTeam();
  const item = await ingest(seed, {
    path: "notes/aio1217provenance.md",
    body: "aio1217provenance synthetic body",
    access: "team",
    project: "aio1217provenance",
  });
  const filled = await backfillTeamContext(db(), seed.teamId);
  if (!filled.ok) throw new Error(`${FIXTURE} context backfill: ${filled.error}`);

  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@aio1217.fixture.test`,
      display_name: "AIO1217 grantless agent",
      actor_handle: `agent-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      kind: "agent",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`${FIXTURE} agent insert: ${error?.message}`);
  const grantless = (data as { id: string }).id;
  // Planted: the groups writer never admits a non-human to a builtin, and the oracle accepts a
  // builtin row from an active human alone.
  await placeMemberByTier(seed.teamId, grantless, "team");

  return { seed, itemId: item.id, member: seed.memberId, grantless };
}

/** The legs up to and including `leg`: what a resolution stopped there was asked for. */
const through = (leg: string): string[] => RESOLVER_LEGS.slice(0, (RESOLVER_LEGS as readonly string[]).indexOf(leg) + 1);

describe("O — visibleItemIds: a resolver read error keeps its provenance through the materializer (real Postgres)", () => {
  it.each(RESOLVER_LEGS)(
    "O1 a failed %s read is an empty set WITH error, and the resolver issues no read after it",
    async (leg) => {
      const world = await seedWorld();

      const { result, trace } = await underFault(leg, (client) =>
        visibleItemIds(client, { teamId: world.seed.teamId, memberId: world.member }),
      );
      expect({ ids: [...result.ids], empty: result.empty, error: result.error, reads: trace.selects }).toEqual({
        ids: [],
        empty: true,
        error: true,
        reads: through(leg),
      });

      // Only the fault differs: the same principal on the same fixture resolves its item, unflagged.
      const clean = await visibleItemIds(db(), { teamId: world.seed.teamId, memberId: world.member });
      expect({ ids: [...clean.ids], empty: clean.empty, error: clean.error }, CONTROL).toEqual({
        ids: [world.itemId],
        empty: false,
        error: undefined,
      });
    },
    ROOMY,
  );

  it.each(ORACLE_LEGS)(
    "O1b a failed %s read yields no project set either: the oracle's error implies empty",
    async (leg) => {
      const world = await seedWorld();

      const { result } = await underFault(leg, (client) =>
        visibleItemIds(client, { teamId: world.seed.teamId, memberId: world.member }),
      );
      expect(result.projectIds).toEqual([]);
    },
    ROOMY,
  );

  it(
    "O2 no fault, no flag: a member resolves its item through all four reads; a principal the oracle grants no project resolves EMPTY without error, ending before the grant and item-membership reads",
    async () => {
      const world = await seedWorld();

      const asMember = tracedDb();
      const granted = await visibleItemIds(asMember.client, { teamId: world.seed.teamId, memberId: world.member });
      expect(
        { ids: [...granted.ids], empty: granted.empty, error: granted.error, reads: asMember.trace.selects },
        CONTROL,
      ).toEqual({ ids: [world.itemId], empty: false, error: undefined, reads: [...RESOLVER_LEGS] });

      const asGrantless = tracedDb();
      const none = await visibleItemIds(asGrantless.client, { teamId: world.seed.teamId, memberId: world.grantless });
      expect({
        ids: [...none.ids],
        empty: none.empty,
        error: none.error,
        projectIds: none.projectIds,
        reads: asGrantless.trace.selects,
      }).toEqual({ ids: [], empty: true, error: undefined, projectIds: [], reads: ["members", "group_members"] });
    },
    ROOMY,
  );

  it.each(ORACLE_LEGS)(
    "O3 unchanged on a failed %s read: visibleProjects answers a plain empty set, and delegatedVisibleItemIds, which reads through it, reports no error (the disclosed agent-token residual)",
    async (leg) => {
      const world = await seedWorld();
      const token = { teamId: world.seed.teamId, memberId: world.member, onBehalfOf: null, projectScope: null };

      const wrapper = await underFault(leg, (client) =>
        visibleProjects(client, { teamId: world.seed.teamId, memberId: world.member }),
      );
      expect({ projects: wrapper.result.projectIds.size, groups: wrapper.result.groupIds.size }).toEqual({
        projects: 0,
        groups: 0,
      });

      const delegated = await underFault(leg, (client) => delegatedVisibleItemIds(client, token));
      expect({
        ids: [...delegated.result.ids],
        empty: delegated.result.empty,
        error: delegated.result.error,
        projectIds: delegated.result.projectIds,
      }).toEqual({ ids: [], empty: true, error: undefined, projectIds: [] });

      // Only the fault differs: the same token resolves its launcher's item.
      const clean = await delegatedVisibleItemIds(db(), token);
      expect({ ids: [...clean.ids], error: clean.error }, CONTROL).toEqual({ ids: [world.itemId], error: undefined });
    },
    ROOMY,
  );
});

describe("M — listMeetingNotesForTeam: an oracle read error rejects instead of listing nothing (real Postgres)", () => {
  it.each(ORACLE_LEGS)(
    "M1 a failed %s read inside visibleItemIds rejects with meeting visibility resolution failed; without the fault the same viewer's list resolves",
    async (leg) => {
      const world = await seedWorld();
      const viewer = { memberId: world.member, tier: "team" as const };

      const { result } = await underFault(leg, (client) =>
        listMeetingNotesForTeam(client, world.seed.teamId, viewer).then(
          (notes) => `resolved with ${notes.length} note(s)`,
          (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      expect(result).toBe("rejected: meeting visibility resolution failed");

      // Only the fault differs: an empty list means the team has no meeting note, not a failed read.
      expect(await listMeetingNotesForTeam(db(), world.seed.teamId, viewer), CONTROL).toEqual([]);
    },
    ROOMY,
  );
});

describe("I — auditVisibilityAgainstItemIds: the error flag is still ignored (real Postgres)", () => {
  it.each(["group_members", "project_groups"] as const)(
    "I1 unchanged on a failed %s read inside visibleItemIds: the item is reported as not visible to the member, as it was before the flag was carried; without the fault it is clean",
    async (leg) => {
      const world = await seedWorld();
      const principal = { teamId: world.seed.teamId, memberId: world.member };

      const { result } = await underFault(leg, (client) => auditVisibilityAgainstItemIds(client, principal, [world.itemId]));
      expect(result).toEqual([world.itemId]);

      expect(await auditVisibilityAgainstItemIds(db(), principal, [world.itemId]), CONTROL).toEqual([]);
    },
    ROOMY,
  );
});
