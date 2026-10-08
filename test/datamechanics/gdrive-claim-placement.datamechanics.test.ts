import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, externalMember, ingest, seedTeam, type Seed } from "./helpers";
import { ensureAccessBootstrap, EXTERNAL_SHARED_SLUG, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { canSeeItem } from "@/lib/access/enforce";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { runSql } from "@/lib/db/pg/pool";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { recordGdriveItemClaim, reconcileGdriveItemClaims } from "@/lib/projects/context/gdrive-claims";
import {
  ensureGdriveClaimMembership,
  ensureIncludeMembership,
} from "@/lib/projects/context/memberships";
import { reconcileItemUnit } from "@/lib/projects/context/units";

/**
 * Drive CLAIM PLACEMENT authorization (AIO-1167 on TIERRET-1).
 *
 * Spec. A Google Drive document is ingested at the conservative `external` tier, and its audience
 * is whatever its connection's admin approved — which may be General. TIERRET-1's target-integrity
 * gate routes by the item's tier (`external` → external-shared only), so the ordinary membership
 * writer correctly refuses an external unit entering General. The claim-authorized entry is the one
 * way in, and it is authorized by the CLAIM, verified inside the membership writer:
 *
 *   · a live claim, in this team, by this connection, for this exact item, naming this exact
 *     destination, recorded under the connection's current generation by an enabled connection;
 *   · on a protected destination, grants that are all still sanctioned.
 *
 * Everything else the writer already guaranteed still holds — unit/item consistency, explicit
 * exclusions, all-or-nothing placement across a mixed audience, revocation — and the method name
 * `gdrive_claim` authorizes nothing by itself.
 *
 * Every positive case is paired with the ordinary caller being refused the same placement, so a
 * regression that simply widens the gate for everyone cannot pass as "Drive works".
 */

interface System {
  general: string;
  externalShared: string;
}

async function converged(): Promise<{ seed: Seed; system: System }> {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const { data } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId)
    .eq("kind", "system").in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  const by = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  return { seed, system: { general: by.get(GENERAL_SLUG)!, externalShared: by.get(EXTERNAL_SHARED_SLUG)! } };
}

/** An initiative granted to a fresh custom group; returns the project and a member of that group. */
async function grantedInitiative(seed: Seed): Promise<{ projectId: string; memberId: string }> {
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `drive-${randomUUID().slice(0, 8)}`, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  expect(error).toBeNull();
  const projectId = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  expect(group.ok, group.error).toBe(true);
  const memberId = await externalMember(seed);
  expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, memberId, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, projectId, group.groupId!, seed.memberId)).ok).toBe(true);
  return { projectId, memberId };
}

async function connection(seed: Seed, audienceProjectIds: string[]): Promise<string> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `drive-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds,
    },
  });
  return row.id;
}

/** A Drive document as the connector stores it: external tier, exact provider id, no placement yet. */
async function driveItem(seed: Seed, providerId: string): Promise<string> {
  const item = await ingest(seed, {
    project: "drive-storage", path: `gdrive/${providerId}.md`, body: `Drive body ${providerId}`,
    access: "external", frontmatter: { source: "gdrive", source_id: providerId },
  });
  return item.id;
}

const claim = (seed: Seed, integrationId: string, providerId: string, itemId: string, projects: string[], generation = 1) =>
  recordGdriveItemClaim(db(), { teamId: seed.teamId, integrationId, providerId, itemId, generation, audienceProjectIds: projects });

async function unitOf(seed: Seed, itemId: string): Promise<string> {
  const unit = await reconcileItemUnit(db(), seed.teamId, itemId);
  expect(unit.ok, unit.error).toBe(true);
  return unit.unitId!;
}

/** Current INCLUDE rows for an item's unit, as `project → method`. Empty when no unit exists. */
async function includes(seed: Seed, itemId: string): Promise<Record<string, string>> {
  const { data: unit } = await db().from("project_context_units").select("id")
    .eq("team_id", seed.teamId).eq("source_item_id", itemId).maybeSingle();
  if (!unit) return {};
  const { data } = await db().from("project_context_memberships").select("project_id, method")
    .eq("team_id", seed.teamId).eq("context_unit_id", (unit as { id: string }).id)
    .eq("decision", "include").is("valid_to", null);
  return Object.fromEntries(((data ?? []) as { project_id: string; method: string }[]).map((r) => [r.project_id, r.method]));
}

async function claimCount(seed: Seed): Promise<number> {
  const { rows } = await runSql<{ n: number }>(
    "select count(*)::int as n from gdrive_item_claims where team_id = $1", [seed.teamId]);
  return rows[0].n;
}

const sees = (seed: Seed, memberId: string, itemId: string) =>
  canSeeItem(db(), { teamId: seed.teamId, memberId }, itemId);

describe("Drive claim placement: a verified claim may select General", () => {
  it("places an external-tier Drive item in General, while the ordinary caller is still refused", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-general");
    const unitId = await unitOf(seed, itemId);

    // The ordinary entry — staging's rule, unchanged: an external unit may not enter General.
    const ordinary = await ensureIncludeMembership(db(), seed.teamId, { projectId: system.general, contextUnitId: unitId });
    expect(ordinary).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(ordinary.error).toMatch(/may enter only 'external-shared'/);
    expect(await includes(seed, itemId)).toEqual({});
    expect(await sees(seed, seed.memberId, itemId), "not yet shared with anyone").toBe(false);

    await claim(seed, integrationId, "doc-general", itemId, [system.general]);

    expect(await includes(seed, itemId)).toEqual({ [system.general]: "gdrive_claim" });
    expect(await sees(seed, seed.memberId, itemId), "an Everyone member reads it through General").toBe(true);
    // The item keeps its conservative tier; the claim chose the audience, it did not relabel anything.
    const { data: item } = await db().from("items").select("access").eq("id", itemId).single();
    expect((item as { access: string }).access).toBe("external");
    // General is not external-shared: an external-only member gains nothing from this placement.
    const outsider = await externalMember(seed);
    expect(await sees(seed, outsider, itemId)).toBe(false);
  });

  it("the ordinary caller stays refused AFTER the claim exists — the claim is not ambient", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.externalShared]);
    const itemId = await driveItem(seed, "doc-ambient");
    await claim(seed, integrationId, "doc-ambient", itemId, [system.externalShared]);
    const unitId = await unitOf(seed, itemId);
    const ordinary = await ensureIncludeMembership(db(), seed.teamId, { projectId: system.general, contextUnitId: unitId });
    expect(ordinary).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(await includes(seed, itemId)).toEqual({ [system.externalShared]: "gdrive_claim" });
  });

  it("an unrelated external item gets no General placement from either entry", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const plain = await ingest(seed, { project: "src", path: "plain.md", body: "plain external", access: "external" });
    const unitId = await unitOf(seed, plain.id);
    expect(await ensureIncludeMembership(db(), seed.teamId, { projectId: system.general, contextUnitId: unitId }))
      .toMatchObject({ ok: false, refusalReason: "system-integrity" });
    expect(await ensureGdriveClaimMembership(db(), seed.teamId, {
      projectId: system.general, contextUnitId: unitId, integrationId, providerId: "never-claimed",
    })).toMatchObject({ ok: false, refused: true, refusalReason: "gdrive-claim-unverified" });
    expect(await includes(seed, plain.id)).toEqual({});
  });
});

describe("Drive claim placement: the method name is not an authorization", () => {
  it("refuses `method: gdrive_claim` on the ordinary entry and writes nothing — even on an ordinary target", async () => {
    const { seed, system } = await converged();
    const { projectId: initiative } = await grantedInitiative(seed);
    const itemId = await driveItem(seed, "doc-method");
    const unitId = await unitOf(seed, itemId);
    for (const projectId of [system.general, system.externalShared, initiative]) {
      const r = await ensureIncludeMembership(db(), seed.teamId, { projectId, contextUnitId: unitId, method: "gdrive_claim" });
      expect(r, projectId).toMatchObject({ ok: false, refused: true, refusalReason: "gdrive-claim-unverified" });
    }
    expect(await includes(seed, itemId)).toEqual({});
    // Control: the same ordinary entry, without the borrowed label, still does its ordinary job.
    expect(await ensureIncludeMembership(db(), seed.teamId, { projectId: initiative, contextUnitId: unitId }))
      .toMatchObject({ ok: true, created: true });
    expect(await includes(seed, itemId)).toEqual({ [initiative]: "ingestion_project" });
  });
});

describe("Drive claim placement: the claim must be THIS claim", () => {
  it.each([
    ["another item's claim", "other-item"],
    ["a destination the claim does not name", "other-destination"],
    ["another team's connection", "other-team"],
    ["a connection that never claimed it", "no-claim"],
  ] as const)("refuses %s", async (_name, variant) => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general, system.externalShared]);
    const itemId = await driveItem(seed, "doc-target");
    const unitId = await unitOf(seed, itemId);

    let args = { projectId: system.general, contextUnitId: unitId, integrationId, providerId: "doc-target" };
    if (variant === "other-item") {
      const other = await driveItem(seed, "doc-other");
      await claim(seed, integrationId, "doc-other", other, [system.general]);
      args = { ...args, providerId: "doc-other" }; // a real, live claim — for a different document
    } else if (variant === "other-destination") {
      await claim(seed, integrationId, "doc-target", itemId, [system.externalShared]);
    } else if (variant === "other-team") {
      const foreign = await converged();
      const foreignIntegration = await connection(foreign.seed, [foreign.system.general]);
      const foreignItem = await driveItem(foreign.seed, "doc-target");
      await claim(foreign.seed, foreignIntegration, "doc-target", foreignItem, [foreign.system.general]);
      args = { ...args, integrationId: foreignIntegration };
    }

    const r = await ensureGdriveClaimMembership(db(), seed.teamId, args);
    expect(r).toMatchObject({ ok: false, refused: true, refusalReason: "gdrive-claim-unverified" });
    expect((await includes(seed, itemId))[system.general], "General must not be opened").toBeUndefined();
  });

  it("positive control: the same call with the item's own live claim is admitted", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-own");
    await claim(seed, integrationId, "doc-own", itemId, [system.general]);
    const unitId = await unitOf(seed, itemId);
    // Already placed by the claim; asking again is idempotent, not a second row.
    expect(await ensureGdriveClaimMembership(db(), seed.teamId, {
      projectId: system.general, contextUnitId: unitId, integrationId, providerId: "doc-own",
    })).toMatchObject({ ok: true, created: false });
    expect(await includes(seed, itemId)).toEqual({ [system.general]: "gdrive_claim" });
  });
});

describe("Drive claim placement: mixed destinations are placed together or not at all", () => {
  it("opens General, external-shared and an initiative from one claim", async () => {
    const { seed, system } = await converged();
    const { projectId: initiative, memberId: initiativeMember } = await grantedInitiative(seed);
    const integrationId = await connection(seed, [system.general, system.externalShared, initiative]);
    const itemId = await driveItem(seed, "doc-mixed");

    await claim(seed, integrationId, "doc-mixed", itemId, [system.general, system.externalShared, initiative]);

    expect(await includes(seed, itemId)).toEqual({
      [system.general]: "gdrive_claim",
      [system.externalShared]: "gdrive_claim",
      [initiative]: "gdrive_claim",
    });
    expect(await sees(seed, seed.memberId, itemId)).toBe(true);
    expect(await sees(seed, initiativeMember, itemId)).toBe(true);
  });

  it("CORRUPT SYSTEM GRANTS: an unsanctioned grant on General refuses the whole claim, atomically", async () => {
    const { seed, system } = await converged();
    const { projectId: initiative, memberId: initiativeMember } = await grantedInitiative(seed);
    const integrationId = await connection(seed, [initiative, system.general]);
    const itemId = await driveItem(seed, "doc-corrupt");
    // RAW forbidden edge: the grant writer refuses system grants, which is why the gate re-checks.
    const vendors = await createGroup(db(), seed.teamId, `vendors-${randomUUID().slice(0, 8)}`, "Vendors", seed.memberId);
    const planted = await db().from("project_groups")
      .insert({ team_id: seed.teamId, project_id: system.general, group_id: vendors.groupId! });
    expect(planted.error, "forbidden-edge fixture must insert").toBeNull();

    await expect(claim(seed, integrationId, "doc-corrupt", itemId, [initiative, system.general]))
      .rejects.toThrow(/system-integrity.*unsanctioned grant/);

    // Nothing partial: not the corrupted General, not the healthy initiative, not the claim itself.
    expect(await includes(seed, itemId)).toEqual({});
    expect(await claimCount(seed)).toBe(0);
    expect(await sees(seed, initiativeMember, itemId)).toBe(false);

    // Repair the edge and the SAME claim goes through — the refusal was the corruption, nothing else.
    await db().from("project_groups").delete().eq("team_id", seed.teamId)
      .eq("project_id", system.general).eq("group_id", vendors.groupId!);
    await claim(seed, integrationId, "doc-corrupt", itemId, [initiative, system.general]);
    expect(await includes(seed, itemId)).toEqual({ [initiative]: "gdrive_claim", [system.general]: "gdrive_claim" });
  });
});

describe("Drive claim placement: what the writer already guaranteed still holds", () => {
  it("an EXPLICIT exclusion is never overridden by a claim", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-excluded");
    const unitId = await unitOf(seed, itemId);
    const excluded = await db().from("project_context_memberships").insert({
      team_id: seed.teamId, project_id: system.general, context_unit_id: unitId,
      decision: "exclude", mode: "force_exclude", method: "manual", decided_by: seed.memberId,
    });
    expect(excluded.error).toBeNull();

    await expect(claim(seed, integrationId, "doc-excluded", itemId, [system.general])).rejects.toThrow(/explicit exclude/);

    expect(await includes(seed, itemId)).toEqual({});
    const { data: standing } = await db().from("project_context_memberships").select("decision, mode")
      .eq("team_id", seed.teamId).eq("context_unit_id", unitId).eq("project_id", system.general).is("valid_to", null);
    expect(standing).toEqual([{ decision: "exclude", mode: "force_exclude" }]);
    expect(await sees(seed, seed.memberId, itemId)).toBe(false);
  });

  it("an AUTOMATIC exclude is replaced by an include that revocation can still find", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-shadow");
    const unitId = await unitOf(seed, itemId);
    await db().from("project_context_memberships").insert({
      team_id: seed.teamId, project_id: system.general, context_unit_id: unitId,
      decision: "exclude", mode: "auto", method: "rule",
    });

    await claim(seed, integrationId, "doc-shadow", itemId, [system.general]);

    // `gdrive_claim`, NOT `exclude_shadow_repair`: the method is what revocation closes rows by.
    expect(await includes(seed, itemId)).toEqual({ [system.general]: "gdrive_claim" });
  });

  it("a unit whose audience mirror disagrees with the locked item is refused before any write", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-mirror");
    await claim(seed, integrationId, "doc-mirror", itemId, [system.general]);
    const unitId = await unitOf(seed, itemId);
    // Close the placement and plant drift, so an include would have to be OPENED against a bad mirror.
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId).eq("context_unit_id", unitId).is("valid_to", null);
    await db().from("project_context_units").update({ audience: "team" }).eq("team_id", seed.teamId).eq("id", unitId);

    const r = await ensureGdriveClaimMembership(db(), seed.teamId, {
      projectId: system.general, contextUnitId: unitId, integrationId, providerId: "doc-mirror",
    });
    expect(r).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(r.error).toMatch(/audience mirror/);
    expect(await includes(seed, itemId)).toEqual({});
  });
});

describe("Drive claim placement: revocation and generation fencing", () => {
  it("REVOCATION (survivor): retiring one connection's claim closes exactly its destination", async () => {
    const { seed, system } = await converged();
    const { projectId: initiative, memberId: initiativeMember } = await grantedInitiative(seed);
    const a = await connection(seed, [system.general]);
    const b = await connection(seed, [initiative]);
    const itemId = await driveItem(seed, "doc-shared");
    await claim(seed, a, "doc-shared", itemId, [system.general]);
    await claim(seed, b, "doc-shared", itemId, [initiative]);
    expect(await includes(seed, itemId)).toEqual({ [system.general]: "gdrive_claim", [initiative]: "gdrive_claim" });

    const staged = await stageGdriveReconciliation(db(), seed.teamId, {
      connectionId: a, removedProviderIds: ["doc-shared"], reason: "connection A lost access",
    });
    expect(staged).toMatchObject({ candidates: 1, cleanupQueued: 0 });

    expect(await includes(seed, itemId), "General closed with the claim that opened it").toEqual({ [initiative]: "gdrive_claim" });
    expect(await sees(seed, seed.memberId, itemId)).toBe(false);
    expect(await sees(seed, initiativeMember, itemId)).toBe(true);
  });

  it("REVOCATION (final claim): the unit is retracted and General no longer serves the document", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-final");
    await claim(seed, integrationId, "doc-final", itemId, [system.general]);
    expect(await sees(seed, seed.memberId, itemId)).toBe(true);

    const staged = await stageGdriveReconciliation(db(), seed.teamId, {
      connectionId: integrationId, removedProviderIds: ["doc-final"], reason: "removed at the source",
    });
    expect(staged).toMatchObject({ candidates: 1, cleanupQueued: 1 });

    const { data: unit } = await db().from("project_context_units").select("state")
      .eq("team_id", seed.teamId).eq("source_item_id", itemId).single();
    expect((unit as { state: string }).state).toBe("retracted");
    expect(await sees(seed, seed.memberId, itemId)).toBe(false);
  });

  it("GENERATION: a claim from a superseded generation cannot open a placement; re-recording it can", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-generation");
    await claim(seed, integrationId, "doc-generation", itemId, [system.general]);
    const unitId = await unitOf(seed, itemId);
    // Take the placement away so the question is whether the OLD claim may open it again …
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId).eq("context_unit_id", unitId).is("valid_to", null);
    // … then change the connection's scope, which advances its generation.
    const scoped = await db().from("integrations").update({
      config: {
        fileIds: ["doc", "another-doc"], folderIds: [], sharedDriveIds: [], recursive: false,
        selectionState: "selected", authMode: "service_account", audienceProjectIds: [system.general],
      },
    }).eq("id", integrationId);
    expect(scoped.error).toBeNull();
    const { rows } = await runSql<{ generation: string | number }>(
      "select generation from gdrive_connection_authority where integration_id = $1", [integrationId]);
    expect(Number(rows[0].generation), "the fixture must actually advance the generation").toBe(2);

    expect(await ensureGdriveClaimMembership(db(), seed.teamId, {
      projectId: system.general, contextUnitId: unitId, integrationId, providerId: "doc-generation",
    })).toMatchObject({ ok: false, refused: true, refusalReason: "gdrive-claim-unverified" });
    // A reconcile over the stale claim neither opens the placement nor fails the caller.
    await expect(reconcileGdriveItemClaims(db(), seed.teamId, itemId)).resolves.toBeUndefined();
    expect(await includes(seed, itemId)).toEqual({});
    expect(await sees(seed, seed.memberId, itemId)).toBe(false);

    // The next fenced sync re-records the claim under the current generation, and it opens again.
    await claim(seed, integrationId, "doc-generation", itemId, [system.general], 2);
    expect(await includes(seed, itemId)).toEqual({ [system.general]: "gdrive_claim" });
    expect(await sees(seed, seed.memberId, itemId)).toBe(true);
  });

  it("a PAUSED connection's claim keeps its placement but cannot open a new one", async () => {
    const { seed, system } = await converged();
    const integrationId = await connection(seed, [system.general]);
    const itemId = await driveItem(seed, "doc-paused");
    await claim(seed, integrationId, "doc-paused", itemId, [system.general]);
    const unitId = await unitOf(seed, itemId);
    await db().from("integrations").update({ status: "disabled" }).eq("id", integrationId);

    // Retained content: pausing is not a revocation.
    await expect(reconcileGdriveItemClaims(db(), seed.teamId, itemId)).resolves.toBeUndefined();
    expect(await includes(seed, itemId)).toEqual({ [system.general]: "gdrive_claim" });

    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId).eq("context_unit_id", unitId).is("valid_to", null);
    expect(await ensureGdriveClaimMembership(db(), seed.teamId, {
      projectId: system.general, contextUnitId: unitId, integrationId, providerId: "doc-paused",
    })).toMatchObject({ ok: false, refused: true, refusalReason: "gdrive-claim-unverified" });
    expect(await includes(seed, itemId)).toEqual({});
  });
});
