import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as itemsPOST } from "@/app/api/v1/items/route";
import { AttributionRepairPendingError } from "@/lib/access/authorization-epoch";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { getPool } from "@/lib/db/pg/pool";
import { listMemberIdentities } from "@/lib/identity/list";
import { drainIdentityRepairs } from "@/lib/ingest/identity-repair";
import { repairAttributionNow } from "@/lib/ingest/reconcile-attribution";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, sha, type Seed } from "./helpers";

/**
 * AIO-1167 R44 F1 — end to end through the real fenced ingest route.
 *
 * Spec (AC-08 closure). A Drive push whose contribution carries an unmapped `permission:P` and the
 * confirmed email of active member A, under the connector's live execution:
 *   · creates the shared identity link P → A (the registry an Admin's identity list reads), and the
 *     document and its contribution evidence are credited to A in the SAME push;
 *   · a replay of that observation whose email now belongs to B is still ONE observation, still A's —
 *     the stable id is the person, an email change transfers nothing.
 * The Admin identity list shows the link. P is first observed with an address naming no member, so an
 * unattributed row exists before the link (a link with nothing behind it completes its repair at
 * once, by design). The new mapping then fences attributed Timeline reads until its repair completes
 * (neither the primed unattributed payload nor a partial one is served); afterwards the Timeline —
 * uncached, and through the cache primed on the unattributed state — shows that one Drive activity
 * under A and none under B.
 */

function post(url: string, key: string, team: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function member(seed: Seed, name: string) {
  const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name, actor_handle: `${name}-${randomUUID().slice(0, 6)}`,
    role: "member", tier: "team", status: "active",
  }).select("id").single();
  return { id: (data as { id: string }).id, email };
}

async function world() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name: "route-docs", status: "enabled",
    config: {
      fileIds: ["d1"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      projectSlug: "docs", access: "team", authMode: "oauth", authenticatedAccountId: "subject:acct",
      scopeSet: ["https://www.googleapis.com/auth/drive.file"], audienceProjectIds: [audience],
    },
  });
  await setIntegrationSecret(db(), auth, row.id, JSON.stringify({
    client_id: "client", client_secret: "secret", refresh_token: "refresh", grant_mode: "files",
    scopes: ["https://www.googleapis.com/auth/drive.file"], account_subject: "subject:acct",
  }));
  const connector = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId });
  const owner = randomUUID();
  const acquired = await executionPOST(post("http://test/api/v1/integrations/gdrive/execution", connector.key, seed.teamSlug, {
    action: "acquire", integration_id: row.id, owner,
  }));
  expect(acquired.status).toBe(200);
  const lease = await acquired.json() as { generation: number; fence: number };
  const headers = {
    "X-AIOS-Integration-Id": row.id,
    "X-AIOS-Execution-Generation": String(lease.generation),
    "X-AIOS-Execution-Fence": String(lease.fence),
    "X-AIOS-Execution-Owner": owner,
  };
  return { seed, integrationId: row.id, key: connector.key, headers, a: await member(seed, "alice"), b: await member(seed, "bob") };
}

// Inside the Timeline window, and fixed for both pushes so the replay is the SAME observation.
const AT = new Date(Date.now() - 3_600_000).toISOString();

function push(w: Awaited<ReturnType<typeof world>>, body: string, email: string) {
  const contribution = { external_id: "permission:P", email, role: "editor", at: AT };
  return itemsPOST(post("http://test/api/v1/items", w.key, w.seed.teamSlug, {
    project: "docs", path: "gdrive/d1.md", kind: "deliverable", access: "team", actor: "gdrive-sync",
    body, content_sha256: sha(body),
    frontmatter: {
      source: "gdrive", source_id: "d1", connection_id: w.integrationId, source_ts: AT,
      authors: [{ provider: "gdrive", external_id: "permission:P", email, role: "editor" }],
      contributions: [contribution],
    },
  }, w.headers));
}

async function credit(teamId: string) {
  const pool = getPool();
  const item = (await pool.query<{ id: string; member_id: string | null; frontmatter: Record<string, unknown> }>(
    "select id, member_id, frontmatter from items where team_id=$1 and path='gdrive/d1.md'", [teamId])).rows[0];
  const evidence = (await pool.query<{ external_id: string | null; member_id: string | null }>(
    "select external_id, member_id from gdrive_contribution_evidence where team_id=$1 and item_id=$2", [teamId, item.id])).rows;
  const mapping = (await pool.query<{ member_id: string }>(
    "select member_id from member_identities where team_id=$1 and provider='gdrive' and external_id='permission:P'",
    [teamId])).rows.map((row) => row.member_id);
  return { item, evidence, mapping };
}

/** Who the Timeline credits with Drive work, and how many observations each. */
function driveCredit(days: TimelineDay[]) {
  return days.flatMap((day) => day.people).flatMap((person) =>
    [...person.tasks.flatMap((task) => task.sources), ...person.other]
      .filter((source) => source.source === "gdrive")
      .map((source) => [person.memberId, source.count] as const));
}

async function timelines(w: Awaited<ReturnType<typeof world>>, itemId: string) {
  const uncached = await getWorkTimeline(db(), w.seed.teamId, "team", undefined, { visibleItemIds: new Set([itemId]) });
  const cached = await getCachedWorkTimeline(db(), w.seed.teamId, "team", w.seed.memberId);
  return { uncached: driveCredit(uncached), cached: driveCredit(cached.days) };
}

describe("Drive identity discovery through the fenced ingest route (R44 F1, real Postgres)", () => {
  it("links P to A and credits A in the same push; a replay under B's email transfers nothing", async () => {
    const w = await world();
    // An attribution-bearing row exists BEFORE the link: P is first observed with an address that
    // names no member, so nothing is linked and nobody is credited. (With no such row, a new link has
    // nothing to repair and the authority completes at once — there would be no fence to observe.)
    const unmapped = `nobody-${randomUUID().slice(0, 6)}@example.com`;
    expect((await push(w, "first body", unmapped)).status).toBe(201);
    const before = await credit(w.seed.teamId);
    expect(before.mapping).toEqual([]);
    expect(before.item.member_id).toBeNull();
    expect(before.evidence).toEqual([{ external_id: "permission:P", member_id: null }]);
    // Prime the reader's cached Timeline on that unattributed state.
    expect(await timelines(w, before.item.id)).toEqual({ uncached: [], cached: [] });

    // The same observation, now carrying A's confirmed address: discovery links P → A.
    expect([200, 201]).toContain((await push(w, "linked body", w.a.email)).status);

    const first = await credit(w.seed.teamId);
    expect(first.item.id).toBe(before.item.id);
    expect(first.mapping).toEqual([w.a.id]);
    expect(first.item.member_id).toBe(w.a.id);
    expect(first.evidence).toEqual([{ external_id: "permission:P", member_id: w.a.id }]);
    const listed = await listMemberIdentities(db(), w.seed.teamId);
    expect(listed.get(w.a.id)?.providers.map((p) => [p.provider, p.externalId])).toEqual([["gdrive", "permission:P"]]);
    expect(listed.get(w.b.id)?.providers ?? []).toEqual([]);

    // The new mapping's repair fences the attributed read; drained, the read serves A's credit.
    await expect(getCachedWorkTimeline(db(), w.seed.teamId, "team", w.seed.memberId))
      .rejects.toBeInstanceOf(AttributionRepairPendingError);
    await drainIdentityRepairs(db(), { maxObligations: 50, batchSize: 50 });
    await repairAttributionNow(db(), w.seed.teamId, w.seed.teamSlug, { maxBatches: 10, batchSize: 50 });
    expect((await db().from("team_identity_authority").select("repair_status")
      .eq("team_id", w.seed.teamId).single()).data).toMatchObject({ repair_status: "complete" });
    expect(await timelines(w, first.item.id)).toEqual({ uncached: [[w.a.id, 1]], cached: [[w.a.id, 1]] });

    // The same observation, re-reported with an email that now belongs to B.
    const replay = await push(w, "second body", w.b.email);
    expect([200, 201]).toContain(replay.status);

    const after = await credit(w.seed.teamId);
    expect(after.mapping).toEqual([w.a.id]);
    expect(after.item.member_id).toBe(w.a.id);
    expect(after.evidence).toEqual([{ external_id: "permission:P", member_id: w.a.id }]);
    expect((after.item.frontmatter.contributions as unknown[]).length).toBe(1);
    expect(await timelines(w, after.item.id)).toEqual({ uncached: [[w.a.id, 1]], cached: [[w.a.id, 1]] });
  });
});
