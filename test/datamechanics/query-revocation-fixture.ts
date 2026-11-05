import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pg/pool";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { mintAgentToken } from "@/lib/access/agent-tokens";
import { getSessionUser } from "@/lib/auth/session";
import { serverClient } from "@/lib/db/server";
import { ensureProjectGraphPointer } from "@/lib/graph/project-pointer";
import { reconcileGdriveItems } from "@/lib/ingest/source-reconcile";
import { upsertIntegration } from "@/lib/integrations/manage";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { recordGdriveItemClaim } from "@/lib/projects/context/gdrive-claims";
import { convergeIdentityAttribution, db, driveFixture, seedTeam, type Seed } from "./helpers";

// AIO-1167 R66/R67 — the shared two-claim query fixture: one Drive document claimed by connection A
// (whose audience is the reader) and connection B (whose audience is another member), the real
// claim owner to retire A, and the two real query routes. The test file owns every `vi.mock`
// (the session and server client among them); this module only builds rows and requests.

export const ITEM_TEXT = "zephyrquartz ledger reconciliation";
export const GRAPH_FACT = "zephyrquartz graph fact: the ledger owner is the payments desk";

async function member(seed: Seed): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Other reader",
    actor_handle: `o-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function audience(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data: group } = await db().from("groups").insert({
    team_id: seed.teamId, slug: `person-${randomUUID()}`, name: slug, person_member_id: memberId,
  }).select("id").single();
  await db().from("group_members").insert({ team_id: seed.teamId, group_id: (group as { id: string }).id, member_id: memberId });
  const { data: project } = await db().from("projects").insert({
    team_id: seed.teamId, slug, name: slug, kind: "initiative",
  }).select("id").single();
  const projectId = (project as { id: string }).id;
  await db().from("project_groups").insert({ team_id: seed.teamId, project_id: projectId, group_id: (group as { id: string }).id });
  const pointer = await ensureProjectGraphPointer(db(), { teamId: seed.teamId, projectId });
  if (!pointer.ok) throw new Error(pointer.error);
  return projectId;
}

async function connection(seed: Seed, name: string, projectId: string): Promise<string> {
  return (await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["ledger-doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [projectId],
    },
  })).id;
}

/** A reader who sees the ledger document ONLY through connection A; connection B serves another member. */
export async function twoClaimFixture() {
  const seed = await seedTeam();
  const other = await member(seed);
  const projectA = await audience(seed, seed.memberId, `ledger-a-${randomUUID().slice(0, 8)}`);
  const projectB = await audience(seed, other, `ledger-b-${randomUUID().slice(0, 8)}`);
  const connectionA = await connection(seed, `ledger-a-${randomUUID().slice(0, 8)}`, projectA);
  const connectionB = await connection(seed, `ledger-b-${randomUUID().slice(0, 8)}`, projectB);
  const providerId = `ledger-doc-${randomUUID()}`;
  const item = await driveFixture(seed, {
    project: "drive-ledger", path: `gdrive/${providerId}.md`, body: `${ITEM_TEXT} — quarterly figures`,
    frontmatter: { source: "gdrive", source_id: providerId, title: "Zephyrquartz ledger" },
  }, { unclaimed: true });
  for (const [integrationId, projectId] of [[connectionA, projectA], [connectionB, projectB]] as const) {
    await recordGdriveItemClaim(db(), {
      teamId: seed.teamId, integrationId, providerId, itemId: item.id, generation: 1, audienceProjectIds: [projectId],
    });
  }
  // A standing agent in the reader's audience group: a token it holds ON BEHALF OF the reader sees the
  // ledger through A exactly as the reader does (the delegated triple intersection).
  const { data: agentRow, error: agentError } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Ledger agent", kind: "agent",
    actor_handle: `ag-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (agentError || !agentRow) throw new Error(`agent seed failed: ${agentError?.message}`);
  const agentId = (agentRow as { id: string }).id;
  const { data: audienceGroup } = await db().from("project_groups").select("group_id")
    .eq("team_id", seed.teamId).eq("project_id", projectA).single();
  await db().from("group_members").insert({
    team_id: seed.teamId, group_id: (audienceGroup as { group_id: string }).group_id, member_id: agentId,
  });
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await backfillTeamContext(db(), seed.teamId);
  await convergeIdentityAttribution(seed);
  const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "query-revocation-dispatch");
  const minted = await mintAgentToken(db(), seed.teamId, {
    memberId: agentId, onBehalfOf: seed.memberId, scope: { kind: "all-reachable" },
  }, seed.memberId);
  if (!minted.ok || !minted.token) throw new Error(`agent token mint failed: ${minted.error}`);
  const agentToken = minted.token;
  const authUserId = randomUUID();
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
  await getPool().query(`update members set auth_user_id=$1 where id=$2 and team_id=$3`, [authUserId, seed.memberId, seed.teamId]);
  vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
  vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
  const revokeA = async () => {
    const before = await revocationEpoch(db(), seed.teamId);
    await reconcileGdriveItems(db(), seed.teamId, {
      connectionId: connectionA, removedProviderIds: [providerId], reason: "connection A revoked",
    });
    // The real retirement advanced the epoch, while B's claim — another member's audience — keeps
    // the document physically present.
    expect(await revocationEpoch(db(), seed.teamId)).toBeGreaterThan(before);
    const { rows } = await getPool().query<{ integration_id: string; active: boolean }>(
      `select integration_id, active from gdrive_item_claims where team_id=$1 and provider_id=$2`, [seed.teamId, providerId]);
    expect(Object.fromEntries(rows.map((row) => [row.integration_id, row.active])))
      .toEqual({ [connectionA]: false, [connectionB]: true });
    expect((await db().from("items").select("id").eq("id", item.id).maybeSingle()).data).not.toBeNull();
  };
  return { seed, key, agentToken, item, revokeA, connectionA, projectA };
}

/** `v1` (API member key), `delegated` (v1 with the agent's token) or `dashboard` (session member). */
export type Route = "v1" | "delegated" | "dashboard";
export async function ask(route: Route, seed: Seed, key: string): Promise<Response> {
  const body = { question: "zephyrquartz ledger owner?" };
  if (route === "v1" || route === "delegated") {
    const { POST } = await import("@/app/api/v1/query/route");
    return POST(new Request("http://test/api/v1/query", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "X-AIOS-Team": seed.teamSlug, "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest);
  }
  const { POST } = await import("@/app/api/dashboard/query/route");
  return POST(new Request("http://test/api/dashboard/query", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: seed.teamSlug, ...body }),
  }) as unknown as NextRequest);
}

/** Everything a turn could have stored from the captured context. */
export async function stored(seed: Seed) {
  const { rows } = await getPool().query(
    `select
       (select coalesce(string_agg(role||':'||content, ' | ' order by created_at), '') from chat_messages where team_id=$1) as messages,
       (select coalesce(string_agg(status||':'||partial_text||':'||coalesce(error_message,''), ' | '), '') from chat_turn_runs where team_id=$1) as runs,
       (select coalesce(string_agg(coalesce(answer_preview,'')||':'||coalesce(cited_item_ids::text,''), ' | '), '') from query_log where team_id=$1) as query_log`,
    [seed.teamId],
  );
  return rows[0] as { messages: string; runs: string; query_log: string };
}

export function expectNothingRevokedLeft(text: string): void {
  expect(text).not.toContain(ITEM_TEXT);
  expect(text).not.toContain(GRAPH_FACT);
}
