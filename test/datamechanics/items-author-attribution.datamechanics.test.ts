import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attributeIncomingItem } from "@/lib/attribution/resolve-authors";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * Spec: a document push carrying an author signal in its frontmatter attributes to the RESOLVED human
 * at ingest — and, when unresolved, a CONNECTOR push leaves it unattributed (null) while a HUMAN
 * self-push keeps the pusher's own attribution. Verified to the stored `items.member_id` (the route→
 * ingest seam), on real Postgres.
 */

async function addConnector(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `sync-${randomUUID()}@test.local`,
      display_name: "Notion Sync",
      actor_handle: `sync-${randomUUID().slice(0, 8)}`,
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

function payload(frontmatter: Record<string, unknown>): ItemPayload {
  const body = `body ${randomUUID()}`;
  return {
    project: "docs",
    path: `notion/${randomUUID()}.md`,
    kind: "deliverable",
    actor: "notion-sync",
    content_sha256: sha(body),
    access: "team",
    body,
    frontmatter,
  } as ItemPayload;
}

/** Drive the exact route path: derive opts, then ingest, and read back the stored member_id. */
async function ingestAs(seed: Seed, actorMemberId: string, fm: Record<string, unknown>): Promise<string | null> {
  const p = payload(fm);
  const { opts } = await attributeIncomingItem(db(), seed.teamId, p, actorMemberId);
  const res = await ingestItem(db(), { teamId: seed.teamId, memberId: actorMemberId, apiKeyId: randomUUID() }, p, "team", opts);
  const { data } = await db().from("items").select("member_id").eq("id", res.id).single();
  return (data as { member_id: string | null }).member_id;
}

describe("author attribution at ingest → stored member_id (real Postgres)", () => {
  it("attributes a document to the RESOLVED human, not the connector that pushed it", async () => {
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: seed.memberId, email: "author@corp.com" });

    const stored = await ingestAs(seed, connectorId, {
      source: "notion",
      authors: [{ role: "author", email: "author@corp.com" }],
    });
    expect(stored).toBe(seed.memberId); // the human — NOT the "Notion Sync" connector
  });

  it("leaves a CONNECTOR push with an unresolvable author UNATTRIBUTED (null), never the connector", async () => {
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    const stored = await ingestAs(seed, connectorId, {
      source: "gdrive",
      authors: [{ role: "author", email: "stranger@elsewhere.com" }],
    });
    expect(stored).toBeNull(); // not the connector, not a wrong human
  });

  it("keeps a HUMAN self-push attributed to the pusher even with an incidental, unmappable author", async () => {
    const seed = await seedTeam(); // seed.memberId is a human
    const stored = await ingestAs(seed, seed.memberId, {
      source: "local",
      authors: [{ role: "author", email: "someone-else@nowhere.com" }],
    });
    expect(stored).toBe(seed.memberId); // self-push retains its own attribution (the HIGH-fix)
  });

  it("passes through untouched when there's no author signal (current behavior preserved)", async () => {
    const seed = await seedTeam();
    const p = payload({ source: "web" });
    const { opts } = await attributeIncomingItem(db(), seed.teamId, p, seed.memberId);
    expect(opts).toBeUndefined();
  });
});
