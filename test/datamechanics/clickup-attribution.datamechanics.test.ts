import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attributeIncomingItem,
  connectorMemberIds,
  parseAuthorRefs,
  resolveAuthors,
} from "@/lib/attribution/resolve-authors";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { ingestItem } from "@/lib/ingest";
import type { ClickUpTaskRecord } from "@/lib/ingest/sources/clickup";
import {
  normalizeClickUpTaskDocs,
  type ClickUpStatusMap,
} from "@/lib/ingest/sources/clickup-normalize";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * Spec (AIO-924): a ClickUp task document attributes to the REAL human its ClickUp assignee maps to —
 * verified to the stored `items.member_id`, on real Postgres, through the same
 * `attributeIncomingItem` → `ingestItem` seam the push route uses.
 *
 * The unit tier can only prove `parseAuthorRefs` returns the right refs. Whether those refs actually
 * resolve depends on `member_identities` rows and the identity map built from them — persistence and
 * lookup, which is this tier's job (CLAUDE §4). The bug shipped green precisely because no test ever
 * crossed from the normalizer into a resolver backed by a real roster.
 */

const STATUS_MAP: ClickUpStatusMap = {
  backlog: "backlog",
  ready: "to do",
  in_progress: "in progress",
  blocked: "blocked",
  done: "complete",
};

function record(assignees: Array<{ id: number | string; username?: string; email?: string }>): ClickUpTaskRecord {
  return {
    task: {
      id: `t-${randomUUID().slice(0, 8)}`,
      name: "Ship the ClickUp read leg",
      markdown_description: "Body text that makes the document searchable.",
      status: { status: "in progress" },
      list: { id: "101", name: "Pilot" },
      assignees,
    },
    observedListIds: ["101"],
  };
}

/** A connector member — the identity a real ClickUp sync would push as. */
async function addConnector(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `clickup-sync-${randomUUID()}@test.local`,
      display_name: "ClickUp Sync",
      actor_handle: `clickup-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      is_connector: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addConnector failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Drive the route's own path: normalize → derive attribution opts → ingest → read the stored owner. */
async function ingestDoc(seed: Seed, pusherId: string, records: ClickUpTaskRecord[]): Promise<string | null> {
  const [doc] = normalizeClickUpTaskDocs({ workspaceId: 9001, records, statusMaps: { "101": STATUS_MAP } });
  const { opts } = await attributeIncomingItem(db(), seed.teamId, doc, pusherId);
  const res = await ingestItem(
    db(),
    { teamId: seed.teamId, memberId: pusherId, apiKeyId: randomUUID() },
    doc,
    "team",
    opts
  );
  const { data } = await db().from("items").select("member_id").eq("id", res.id).single();
  return (data as { member_id: string | null }).member_id;
}

describe("ClickUp task documents → stored items.member_id (real Postgres)", () => {
  it("attributes to the human behind the ClickUp assignee id, not the sync connector", async () => {
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    await db().from("member_identities").insert({
      team_id: seed.teamId,
      member_id: seed.memberId,
      provider: "clickup",
      external_id: "7",
      handle: "alex",
    });

    const stored = await ingestDoc(seed, connectorId, [record([{ id: 7, username: "Alex" }])]);
    expect(stored).toBe(seed.memberId);
    expect(stored).not.toBe(connectorId); // the INVARIANT: never the ingesting connector
  });

  it("falls back to the assignee's EMAIL when no clickup provider id is mapped", async () => {
    // A team that has never run the ClickUp identity sync still has emails on the roster. The
    // structured `authors[]` ref carries both signals, so `resolveRef` can try the id, miss, and
    // still land the person — which a bare `{provider, external_id}` ref could not.
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    await db()
      .from("member_emails")
      .insert({ team_id: seed.teamId, member_id: seed.memberId, email: "alex@corp.example" });

    const stored = await ingestDoc(seed, connectorId, [
      record([{ id: 4242, username: "Alex", email: "alex@corp.example" }]),
    ]);
    expect(stored).toBe(seed.memberId);
  });

  it("credits EVERY mapped assignee, not just the one a singular assignee_id could have named", async () => {
    // The reason the fix is `authors[]` and not a singular `assignee_id`: ClickUp tasks are
    // multi-assignee, and `resolvedMemberIds` is what the credit/health layer reads.
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    const { data: second } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `robin-${randomUUID()}@test.local`,
        display_name: "Robin",
        actor_handle: `robin-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    const robinId = (second as { id: string }).id;
    await db().from("member_identities").insert([
      { team_id: seed.teamId, member_id: seed.memberId, provider: "clickup", external_id: "7" },
      { team_id: seed.teamId, member_id: robinId, provider: "clickup", external_id: "9" },
    ]);

    const [doc] = normalizeClickUpTaskDocs({
      workspaceId: 9001,
      statusMaps: { "101": STATUS_MAP },
      records: [record([{ id: 7, username: "Alex" }, { id: 9, username: "Robin" }])],
    });
    const [map, connectors] = await Promise.all([
      buildIdentityMap(db(), seed.teamId),
      connectorMemberIds(db(), seed.teamId),
    ]);
    const resolution = resolveAuthors(map, parseAuthorRefs(doc.frontmatter ?? {}), connectors);
    expect([...resolution.resolvedMemberIds].sort()).toEqual([seed.memberId, robinId].sort());
    expect(resolution.method).toBe("provider");
    expect(resolution.resolvedMemberIds).not.toContain(connectorId);
  });

  it("leaves an UNASSIGNED ClickUp task unattributed rather than crediting the connector", async () => {
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    const stored = await ingestDoc(seed, connectorId, [record([])]);
    expect(stored).toBeNull();
  });
});
