import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { canSeeItem } from "@/lib/access/enforce";
import { getPool } from "@/lib/db/pg/pool";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { runManualContextPass } from "@/lib/ingest/manual-context";
import { upsertIntegration } from "@/lib/integrations/manage";
import { backfillAllTeams, backfillTeamContext } from "@/lib/projects/context/backfill";
import { selectCandidateItemIds } from "@/lib/projects/context/backfill-candidates";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { reconcileItemContext, systemProjectIds } from "@/lib/projects/context/reconcile-item";
import {
  approvedAudienceProject,
  db,
  externalMember,
  ingest,
  seedTeam,
  transactionSessionDecoratedDb,
  type Seed,
} from "./helpers";

/**
 * A DRIVE-OWNED ITEM IS NEVER PLACED BY GENERIC CONTEXT RECONCILIATION (AIO-1167 X-04 / X-04a),
 * against real PostgreSQL, through every generic caller.
 *
 * Spec. A Google Drive document's context comes solely from its connections' surviving audience
 * claims. The generic owner routes by tier, and a Drive document is stored `external`: reaching it
 * would open an include in external-shared — publishing the document to every external-tier member
 * — and close a claim-authorized placement in General. Two filters kept Drive items away from it,
 * and both read only the row's stored `frontmatter.source`, which can be missing or altered. So:
 *
 *   1. Ownership is the stored provenance OR an exact same-team `source='gdrive'` mapping for the
 *      item. The locked owner decides it first, on its own session, after the row lock, before any
 *      write; the candidate query excludes the same items so the sweep never visits them.
 *   2. Nothing about the connection ends ownership: not a NULL `connection_id`, a disabled
 *      integration, an inactive claim, or no claim at all.
 *   3. A mapping read that fails, or does not answer, writes nothing.
 *   4. A mapping in another team or from another source names nothing here, and every ordinary
 *      item is routed exactly as before.
 *
 * "Nothing was written" is asserted on the complete stored unit and membership rows (closed ones
 * included), not on a count — and each case carries an ordinary item the same pass DID place, so a
 * pass that simply did not run cannot pass for a refusal.
 */

const admin = vi.hoisted(() => ({ teamId: "", memberId: "" }));
vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => (admin.teamId ? { teamId: admin.teamId, memberId: admin.memberId } : null),
}));
const { runContextBackfillAction } = await import("@/app/t/[team]/admin/access/actions");

beforeEach(() => {
  admin.teamId = "";
  admin.memberId = "";
});

/** An initiative only `memberId` is granted — the restricted audience a claim places a document in. */
async function restrictedAudience(seed: Seed, memberId: string): Promise<string> {
  const slug = `restricted-${randomUUID().slice(0, 8)}`;
  const { data: existingGroup } = await db().from("groups").select("id")
    .eq("team_id", seed.teamId).eq("person_member_id", memberId).maybeSingle();
  const group = existingGroup ?? (await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single()).data;
  if (!group) throw new Error("audience group fixture failed");
  if (!existingGroup) {
    await db().from("group_members").insert({
      team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId,
    });
  }
  const { data: project, error: projectError } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  if (projectError || !project) throw new Error(`audience project fixture failed: ${projectError?.message}`);
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({
    team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id,
  });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function connection(seed: Seed, audienceProjectId: string): Promise<string> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `drive-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account",
      audienceProjectIds: [audienceProjectId],
    },
  });
  return row.id;
}

interface DriveDoc { itemId: string; providerId: string; integrationId: string }

/** A Drive document ingested through the real owner and claim-placed in `audienceProjectId`. */
async function claimedDriveDoc(seed: Seed, audienceProjectId: string): Promise<DriveDoc> {
  const providerId = `doc-${randomUUID().slice(0, 12)}`;
  const integrationId = await connection(seed, audienceProjectId);
  const item = await ingest(seed, {
    project: "drive-storage", path: `gdrive/${providerId}.md`, body: `Drive body ${providerId}`,
    access: "external", frontmatter: { source: "gdrive", source_id: providerId, title: providerId },
  });
  await recordGdriveItemClaim(db(), {
    teamId: seed.teamId, integrationId, providerId, itemId: item.id, generation: 1,
    audienceProjectIds: [audienceProjectId],
  });
  return { itemId: item.id, providerId, integrationId };
}

/** The stored provenance goes missing or is altered; the mapping is what still says "Drive". */
async function setFrontmatter(itemId: string, frontmatter: Record<string, unknown>): Promise<void> {
  await getPool().query("update items set frontmatter=$2::jsonb where id=$1", [itemId, JSON.stringify(frontmatter)]);
}

interface MappingRow { source: string; item_id: string; connection_id: string | null }

async function mappings(teamId: string, itemId: string): Promise<MappingRow[]> {
  const { rows } = await getPool().query<MappingRow>(
    "select source, item_id, connection_id from source_item_mappings where team_id=$1 and item_id=$2 order by source",
    [teamId, itemId]);
  return rows;
}

/** Every stored unit and membership row for one item — closed rows and every column included. */
async function contextRows(seed: Seed, itemId: string): Promise<{ units: unknown[]; memberships: unknown[] }> {
  const { rows } = await getPool().query<{ units: unknown[] | null; memberships: unknown[] | null }>(
    `select (select jsonb_agg(to_jsonb(u) order by u.id) from project_context_units u
              where u.team_id=$1 and u.source_item_id=$2) as units,
            (select jsonb_agg(to_jsonb(m) order by m.id)
               from project_context_memberships m join project_context_units u
                 on u.team_id=m.team_id and u.id=m.context_unit_id
              where u.team_id=$1 and u.source_item_id=$2) as memberships`,
    [seed.teamId, itemId]);
  return { units: rows[0].units ?? [], memberships: rows[0].memberships ?? [] };
}

/** The item's CURRENT placements: project and the method that wrote each. */
async function placements(seed: Seed, itemId: string): Promise<{ project_id: string; method: string; decision: string }[]> {
  const { rows } = await getPool().query<{ project_id: string; method: string; decision: string }>(
    `select m.project_id, m.method, m.decision
       from project_context_memberships m join project_context_units u
         on u.team_id=m.team_id and u.id=m.context_unit_id
      where u.team_id=$1 and u.source_item_id=$2 and m.valid_to is null
      order by m.project_id`, [seed.teamId, itemId]);
  return rows;
}

async function sys(seed: Seed) {
  const ids = await systemProjectIds(db(), seed.teamId);
  if (!ids) throw new Error("system projects missing");
  return ids;
}

async function candidates(seed: Seed): Promise<string[]> {
  return (await selectCandidateItemIds(seed.teamId, { limit: 1000 })).ids;
}

const sees = (seed: Seed, memberId: string, itemId: string) => canSeeItem(db(), { teamId: seed.teamId, memberId }, itemId);

/**
 * Every generic caller, in turn: the direct per-item reconcile (the items-route hook and the
 * meeting writers call exactly this), the per-team sweep, the scheduler's all-teams leg, the
 * manual-sync pass and the Admin backfill action.
 */
async function runEveryGenericCaller(seed: Seed, itemId: string): Promise<void> {
  expect(await reconcileItemContext(db(), seed.teamId, itemId), "direct")
    .toEqual({ ok: true, skipped: true, driveOwned: true });
  expect(await reconcileItemContext(db(), seed.teamId, itemId, await sys(seed)), "direct, with the sweep's topology hints")
    .toEqual({ ok: true, skipped: true, driveOwned: true });
  expect(await backfillTeamContext(db(), seed.teamId), "sweep").toMatchObject({ ok: true, cursor: null });
  const scheduled = await backfillAllTeams(db(), new Date(Date.now() + 60_000).toISOString());
  expect(scheduled.outcomes.find((outcome) => outcome.teamId === seed.teamId), "scheduled").toMatchObject({ ok: true, drained: true });
  expect(await runManualContextPass(seed.teamId, "manual_sync"), "manual").toMatchObject({ status: "complete", error: null });
  admin.teamId = seed.teamId;
  admin.memberId = seed.memberId;
  expect(await runContextBackfillAction(seed.teamSlug), "admin").toMatchObject({ ok: true });
}

describe("AIO-1167 X-04 — generic context reconciliation never places a Drive-owned item (real Postgres)", () => {
  it("MAPPED, provenance MISSING, claim-placed in a restricted initiative: every generic caller leaves it exactly where the claim put it, and an external member still cannot see it", async () => {
    const seed = await seedTeam();
    // The roster is complete before any item exists, so no attribution repair is left pending.
    const outsider = await externalMember(seed);
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const audience = await restrictedAudience(seed, seed.memberId);
    const doc = await claimedDriveDoc(seed, audience);
    const ordinary = await ingest(seed, { path: "ordinary-external.md", body: "ordinary", access: "external", project: "src" });

    expect(await placements(seed, doc.itemId)).toEqual([{ project_id: audience, method: "gdrive_claim", decision: "include" }]);
    expect(await sees(seed, seed.memberId, doc.itemId)).toBe(true);
    expect(await sees(seed, outsider, doc.itemId)).toBe(false);

    // The trigger: the row no longer says it is a Drive document. Its mapping still does — with
    // the NULL connection id every claimed document's mapping has.
    await setFrontmatter(doc.itemId, {});
    expect(await mappings(seed.teamId, doc.itemId)).toEqual([{ source: "gdrive", item_id: doc.itemId, connection_id: null }]);
    const before = await contextRows(seed, doc.itemId);
    expect(before.memberships).toHaveLength(1);

    // It is not a candidate — while an ordinary external item with nothing placed yet is.
    const selected = await candidates(seed);
    expect(selected).toContain(ordinary.id);
    expect(selected).not.toContain(doc.itemId);

    await runEveryGenericCaller(seed, doc.itemId);

    // NON-VACUITY: the same passes did place the ordinary external item, in external-shared.
    const system = await sys(seed);
    expect((await placements(seed, ordinary.id)).map((row) => row.project_id)).toEqual([system.externalShared]);
    expect(await sees(seed, outsider, ordinary.id)).toBe(true);
    // The Drive document: not one stored row differs, and nobody new can read it.
    expect(await contextRows(seed, doc.itemId)).toEqual(before);
    expect(await sees(seed, seed.memberId, doc.itemId)).toBe(true);
    expect(await sees(seed, outsider, doc.itemId)).toBe(false);
  }, 120_000);

  it("MAPPED, provenance ALTERED, claim-placed in GENERAL: the authorized placement is not closed and nothing is opened in external-shared", async () => {
    const seed = await seedTeam();
    const outsider = await externalMember(seed);
    const general = await approvedAudienceProject(seed, "team");
    const doc = await claimedDriveDoc(seed, general);
    const system = await sys(seed);
    expect(system.general).toBe(general);
    expect(await placements(seed, doc.itemId)).toEqual([{ project_id: general, method: "gdrive_claim", decision: "include" }]);

    // Relabelled, as a pusher could: stored `external`, the tier the generic owner routes to
    // external-shared — closing General on the way.
    await setFrontmatter(doc.itemId, { source: "notion", title: "relabelled" });
    const before = await contextRows(seed, doc.itemId);

    await runEveryGenericCaller(seed, doc.itemId);

    expect(await contextRows(seed, doc.itemId)).toEqual(before);
    expect(await placements(seed, doc.itemId)).toEqual([{ project_id: general, method: "gdrive_claim", decision: "include" }]);
    expect(await sees(seed, seed.memberId, doc.itemId)).toBe(true);
    expect(await sees(seed, outsider, doc.itemId)).toBe(false);
  }, 120_000);

  it("NOTHING ABOUT THE CONNECTION ENDS OWNERSHIP: a disabled integration, an inactive claim and no current placement at all still leave the item to Drive", async () => {
    const seed = await seedTeam();
    const outsider = await externalMember(seed);
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const audience = await restrictedAudience(seed, seed.memberId);
    const doc = await claimedDriveDoc(seed, audience);
    await setFrontmatter(doc.itemId, {});

    // Disconnected in every way the generic owner might have been tempted to consult. The claim's
    // placement is closed, as a real revocation leaves it: no current include anywhere — the exact
    // state the sweep's "no include in the target project" arm exists to repair for other items.
    await getPool().query("update integrations set status='disabled' where id=$1", [doc.integrationId]);
    const claims = await getPool().query(
      "update gdrive_item_claims set active=false where team_id=$1 and integration_id=$2 and provider_id=$3",
      [seed.teamId, doc.integrationId, doc.providerId]);
    expect(claims.rowCount).toBe(1);
    await getPool().query(
      `update project_context_memberships m set valid_to=now()
         from project_context_units u
        where u.team_id=m.team_id and u.id=m.context_unit_id and u.team_id=$1 and u.source_item_id=$2 and m.valid_to is null`,
      [seed.teamId, doc.itemId]);
    expect(await placements(seed, doc.itemId)).toEqual([]);
    expect((await mappings(seed.teamId, doc.itemId))[0]).toMatchObject({ source: "gdrive", connection_id: null });
    const before = await contextRows(seed, doc.itemId);

    expect(await candidates(seed)).not.toContain(doc.itemId);
    await runEveryGenericCaller(seed, doc.itemId);

    expect(await contextRows(seed, doc.itemId)).toEqual(before);
    expect(await placements(seed, doc.itemId)).toEqual([]);
    expect(await sees(seed, outsider, doc.itemId)).toBe(false);
  }, 120_000);

  it("X-04a — STORED PROVENANCE ALONE is ownership too: a Drive-sourced row with no mapping is neither a candidate nor placed", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    // A row whose frontmatter says Drive and that no mapping names: the case the call-site filters
    // were written for. Stored directly — the ingest owner would mint a mapping for it.
    const ordinary = await ingest(seed, { path: "ordinary.md", body: "ordinary", access: "team", project: "src" });
    const { rows: stored } = await getPool().query<{ id: string }>(
      `insert into items (team_id, project_id, path, kind, access, frontmatter, content_sha256)
       select team_id, project_id, 'gdrive/legacy.md', 'deliverable', 'external', $2::jsonb, md5('legacy')
         from items where id=$1 returning id`,
      [ordinary.id, JSON.stringify({ source: "gdrive", source_id: "legacy-doc" })]);
    const legacy = stored[0].id;
    expect(await mappings(seed.teamId, legacy)).toEqual([]);

    const selected = await candidates(seed);
    expect(selected).toContain(ordinary.id);
    expect(selected).not.toContain(legacy);
    await runEveryGenericCaller(seed, legacy);
    expect(await contextRows(seed, legacy)).toEqual({ units: [], memberships: [] });
    expect((await placements(seed, ordinary.id)).map((row) => row.project_id)).toEqual([(await sys(seed)).general]);
  }, 120_000);
});

describe("AIO-1167 X-04 — the locked check is the authority, and it fails closed (real Postgres)", () => {
  it("CANDIDATE → LOCK: an item selected as a candidate and mapped before its row lock is granted is refused on a fresh read", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const item = await ingest(seed, { path: "adopted.md", body: "adopted", access: "external", project: "src" });
    // It is an ordinary candidate now: no mapping, no Drive provenance, nothing placed.
    expect(await candidates(seed)).toContain(item.id);

    // Another transaction holds the row and, while it does, the item becomes a Drive document.
    const adopter = new Client({ connectionString: process.env.DATABASE_URL });
    adopter.on("error", () => undefined);
    await adopter.connect();
    let reconcile: ReturnType<typeof reconcileItemContext> | undefined;
    try {
      await adopter.query("begin");
      await adopter.query("select id from items where id=$1 for update", [item.id]);
      const backend = (await adopter.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      reconcile = reconcileItemContext(db(), seed.teamId, item.id);
      reconcile.catch(() => undefined);
      // The reconcile is waiting for the row — it has read nothing about ownership yet.
      await expect.poll(async () => (await getPool().query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))`,
        [backend])).rows[0].n, { timeout: 10_000 }).toBe(1);
      await adopter.query(
        `insert into source_item_mappings (team_id, source, provider_id, item_id) values ($1, 'gdrive', $2, $3)`,
        [seed.teamId, `adopted-${randomUUID().slice(0, 8)}`, item.id]);
      await adopter.query("commit");
    } finally {
      await adopter.query("rollback").catch(() => undefined);
      await adopter.end().catch(() => undefined);
    }

    expect(await reconcile).toEqual({ ok: true, skipped: true, driveOwned: true });
    expect(await contextRows(seed, item.id)).toEqual({ units: [], memberships: [] });
    expect(await candidates(seed)).not.toContain(item.id);
  }, 60_000);

  it("MAPPING READ FAILURE: the read precedes every write, so a failed or unanswered read leaves no unit and no membership — and the same item is placed once the read answers", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const item = await ingest(seed, { path: "unread.md", body: "unread", access: "team", project: "src" });
    expect(await contextRows(seed, item.id)).toEqual({ units: [], memberships: [] });

    const reads: string[] = [];
    const withMappingRead = (answer: (text: string) => { rows: unknown[] } | Error) =>
      transactionSessionDecoratedDb(db(), (session) => ({
        ...session,
        executeSql: async <T>(text: string, params: unknown[] = []) => {
          if (!/\bsource_item_mappings\b/.test(text)) return session.executeSql<T>(text, params);
          reads.push(text);
          const result = answer(text);
          if (result instanceof Error) throw result;
          return { ...(await session.executeSql<T>(text, params)), rows: result.rows as T[] };
        },
      }));

    const failed = await reconcileItemContext(withMappingRead(() => new Error("mapping read unavailable")), seed.teamId, item.id);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("mapping read unavailable");
    for (const rows of [[], [{ drive_mapped: null }], [{ drive_mapped: true }, { drive_mapped: false }], [{}]]) {
      const unanswered = await reconcileItemContext(withMappingRead(() => ({ rows })), seed.teamId, item.id);
      expect(unanswered.ok, JSON.stringify(rows)).toBe(false);
      expect(unanswered.error, JSON.stringify(rows)).toContain("Drive ownership could not be read for a locked item");
    }
    // The ownership read really was issued each time, exact to team + item + source…
    expect(reads).toHaveLength(5);
    for (const text of reads) {
      expect(text).toMatch(/where m\.team_id = \$1 and m\.item_id = \$2 and m\.source = 'gdrive'/);
    }
    // …and nothing was written by any of the five attempts.
    expect(await contextRows(seed, item.id)).toEqual({ units: [], memberships: [] });

    // CONTROL: with the read answering, the very same item is reconciled and placed in General.
    expect(await reconcileItemContext(db(), seed.teamId, item.id)).toMatchObject({ ok: true, unitCreated: true, membershipCreated: true });
    expect((await placements(seed, item.id)).map((row) => row.project_id)).toEqual([(await sys(seed)).general]);
  });

  it("EXACT: a mapping from another source, or one in another team naming this item id, is not ownership — ordinary routing is unchanged", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const system = await sys(seed);
    const otherSource = await ingest(seed, { path: "notion-mapped.md", body: "notion", access: "team", project: "src" });
    const otherTeam = await ingest(seed, { path: "other-team-mapped.md", body: "elsewhere", access: "external", project: "src" });
    const plain = await ingest(seed, { path: "plain.md", body: "plain", access: "team", project: "src" });
    await getPool().query(
      `insert into source_item_mappings (team_id, source, provider_id, item_id) values ($1, 'notion', 'page-1', $2), ($3, 'gdrive', 'doc-1', $4)`,
      [seed.teamId, otherSource.id, other.teamId, otherTeam.id]);

    expect((await candidates(seed)).sort()).toEqual([otherSource.id, otherTeam.id, plain.id].sort());
    expect(await backfillTeamContext(db(), seed.teamId)).toMatchObject({ ok: true, scanned: 3, unitsCreated: 3, membershipsCreated: 3, cursor: null });

    expect((await placements(seed, otherSource.id)).map((row) => [row.project_id, row.decision])).toEqual([[system.general, "include"]]);
    expect((await placements(seed, otherTeam.id)).map((row) => [row.project_id, row.decision])).toEqual([[system.externalShared, "include"]]);
    expect((await placements(seed, plain.id)).map((row) => [row.project_id, row.decision])).toEqual([[system.general, "include"]]);
    // A tier flip still moves an ordinary item: external-shared closes, General opens.
    await getPool().query("update items set access='team' where id=$1", [otherTeam.id]);
    expect(await reconcileItemContext(db(), seed.teamId, otherTeam.id)).toMatchObject({ ok: true, membershipCreated: true });
    expect((await placements(seed, otherTeam.id)).map((row) => row.project_id)).toEqual([system.general]);
    expect(await candidates(seed)).toEqual([]);
  });
});
