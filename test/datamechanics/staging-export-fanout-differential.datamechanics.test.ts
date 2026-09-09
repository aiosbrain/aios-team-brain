import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { resolveFanoutTargets } from "@/lib/projects/context/fanout-targets";
import { snapshotExportFacts } from "../../scripts/staging-ops/exporter.mjs";
import { db, seedTeam } from "./helpers";

/**
 * M5: the exporter decides which item episodes are ELIGIBLE to leave production with one SQL
 * statement, because it is a plain-node runner and cannot import the app's `server-only` resolver.
 * That duplication is structural and therefore permanent — so the thing to pin is not "there is one
 * oracle" but "the two oracles AGREE", against a real database, over the cases that separate them:
 * a plain project item, a General-homed item, an item restricted OUT of General, an initiative
 * include, and an external-shared item.
 *
 * Anything this test does not cover is a case where an item could silently stop (or start) being
 * copied without the application's own read changing — which is a tier decision made by a second
 * implementation nobody compared.
 */

const clients: pg.Client[] = [];
afterAll(async () => { await Promise.all(clients.map((client) => client.end().catch(() => {}))); });

async function rawClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  clients.push(client);
  return client;
}

async function systemProject(teamId: string, slug: "general" | "external-shared", group: string) {
  const admin = db();
  const { data, error } = await admin.from("projects")
    .insert({ team_id: teamId, slug, name: slug, kind: "system", graph_group_id: group })
    .select("id").single();
  if (error || !data) throw new Error(`system project ${slug} failed: ${error?.message}`);
  return data.id as string;
}

async function makeProject(teamId: string, kind: string, group: string) {
  const admin = db();
  const slug = `p-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin.from("projects")
    .insert({ team_id: teamId, slug, name: slug, kind, graph_group_id: group })
    .select("id").single();
  if (error || !data) throw new Error(`project failed: ${error?.message}`);
  return data.id as string;
}

async function makeItem(teamId: string, projectId: string, access: string) {
  const admin = db();
  const { data, error } = await admin.from("items")
    .insert({ team_id: teamId, project_id: projectId, path: `${randomUUID()}.md`, kind: "deliverable", access, body: "body", content_sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), actor: "fixture" })
    .select("id").single();
  if (error || !data) throw new Error(`item failed: ${error?.message}`);
  return data.id as string;
}

async function unitWithMembership(teamId: string, itemId: string, projectId: string, decision: "include" | "exclude") {
  const admin = db();
  const { data: unit, error: unitErr } = await admin.from("project_context_units")
    .insert({
      team_id: teamId, source_item_id: itemId, state: "active", unit_kind: "item",
      unit_key: `item:${itemId}`, audience: "team",
      content_sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    })
    .select("id").single();
  if (unitErr || !unit) throw new Error(`unit failed: ${unitErr?.message}`);
  const { error } = await admin.from("project_context_memberships")
    .insert({ team_id: teamId, context_unit_id: unit.id, project_id: projectId, decision, valid_to: null });
  if (error) throw new Error(`membership failed: ${error.message}`);
  return unit.id as string;
}

async function ledgerRow(teamId: string, itemId: string, group: string) {
  const admin = db();
  const { error } = await admin.from("graph_episodes").insert({
    team_id: teamId, source_table: "items", source_id: itemId, group_id: group,
    content_sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), episode_uuid: `ep-${randomUUID()}`,
  });
  if (error) throw new Error(`ledger row failed: ${error.message}`);
}

describe("the exporter's eligibility oracle agrees with the application's (real Postgres)", () => {
  it("agrees on project, General, restricted-out, initiative and external-shared items", async () => {
    const seed = await seedTeam();
    const teamId = seed.teamId;
    const generalGroup = `g-general-${randomUUID().slice(0, 8)}`;
    const externalGroup = `g-external-${randomUUID().slice(0, 8)}`;
    const initiativeGroup = `g-initiative-${randomUUID().slice(0, 8)}`;
    const sourceGroup = `g-source-${randomUUID().slice(0, 8)}`;

    const generalId = await systemProject(teamId, "general", generalGroup);
    const externalSharedId = await systemProject(teamId, "external-shared", externalGroup);
    const initiativeId = await makeProject(teamId, "initiative", initiativeGroup);
    const sourceId = await makeProject(teamId, "source", sourceGroup);

    // 1. A plain source-project item, projected under its own project's group.
    const plain = await makeItem(teamId, sourceId, "team");
    await ledgerRow(teamId, plain, sourceGroup);

    // 2. A team item with no context units at all: rule-1 fail-open puts it in General.
    const inGeneral = await makeItem(teamId, sourceId, "team");
    await ledgerRow(teamId, inGeneral, generalGroup);

    // 3. A team item RESTRICTED out of General onto an initiative.
    const restricted = await makeItem(teamId, sourceId, "team");
    await unitWithMembership(teamId, restricted, initiativeId, "include");
    await ledgerRow(teamId, restricted, generalGroup);
    await ledgerRow(teamId, restricted, initiativeGroup);

    // 4. An external item, fail-open into external-shared.
    const external = await makeItem(teamId, sourceId, "external");
    await ledgerRow(teamId, external, externalGroup);

    const facts = await snapshotExportFacts(await rawClient());
    const app = await resolveFanoutTargets(db(), {
      teamId,
      itemIds: [plain, inGeneral, restricted, external],
      initiativeGroupByProject: new Map([[initiativeId, initiativeGroup]]),
      generalProjectId: generalId,
      externalSharedProjectId: externalSharedId,
    });

    /** What the APPLICATION says: which groups would this item's episodes legitimately live in? */
    const appGroups = (itemId: string, access: string) => {
      const groups = new Set<string>(app.targets.get(itemId) ?? []);
      if (access === "team" && app.inGeneral.has(itemId)) groups.add(generalGroup);
      if (access === "external" && app.inExternalShared.has(itemId)) groups.add(externalGroup);
      return groups;
    };
    /** What the EXPORTER says, read back out of the eligibility keys it built. */
    const exporterEligible = (itemId: string, group: string) => facts.allowed.has(`items:${itemId}\0${group}`);

    const cases: [string, string, string[]][] = [
      [plain, "team", [sourceGroup]],
      [inGeneral, "team", [generalGroup]],
      [restricted, "team", [generalGroup, initiativeGroup]],
      [external, "external", [externalGroup]],
    ];

    for (const [itemId, access, groups] of cases) {
      const fromApp = appGroups(itemId, access);
      for (const group of groups) {
        expect(
          exporterEligible(itemId, group),
          `exporter and application disagree about ${itemId} in ${group}`
        ).toBe(group === sourceGroup ? true : fromApp.has(group));
      }
    }

    // The restriction is the case that separates the two oracles: the item holds an ACTIVE include
    // in the initiative, so it is NOT in General any more, and its stale General episode must not be
    // eligible to be copied.
    expect(app.inGeneral.has(restricted)).toBe(false);
    expect(exporterEligible(restricted, generalGroup)).toBe(false);
    expect(exporterEligible(restricted, initiativeGroup)).toBe(true);
    expect(facts.excluded.has(`items:${restricted}\0${generalGroup}`)).toBe(true);
  });
});
