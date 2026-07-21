import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as itemsPOST } from "@/app/api/v1/items/route";
import { issueApiKey } from "@/lib/admin/keys";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * lib/ingest (`ingestItem`) is the SOLE service-role writer for `items` — it bypasses RLS
 * entirely and there is NO DB-level tier backstop on WHICH access values are legal to write
 * (only that the column's enum values are 'team'|'external' — see postgres/schema.sql
 * `access_tier`). The admin/private-tier 422 rejection lives ENTIRELY in the route boundary
 * (app/api/v1/items/route.ts), one layer above ingestItem, which is typed to accept only
 * "team" | "external" and never even sees "admin". This file proves that boundary against the
 * real route handler + real Postgres: an admin/private/unknown-tier push is rejected 422
 * BEFORE ingestItem runs (no row written), while legitimate team/external pushes persist.
 */

const URL = "http://test/api/v1/items";

async function issueKeyFor(seed: Seed, tier: "team" | "external") {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
  }
  const { key, keyId } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  const { data: row } = await db().from("api_keys").select("id").eq("key_id", keyId).single();
  return { key, apiKeyId: (row as { id: string }).id, memberId };
}

function post(key: string, teamSlug: string, body: unknown) {
  const req = new Request(URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "X-AIOS-Team": teamSlug,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return itemsPOST(req);
}

function itemBody(access: string, path: string) {
  const body = `content for ${path}`;
  return {
    project: "acme",
    path,
    kind: "deliverable",
    content_sha256: sha(body),
    access,
    actor: "tester",
    frontmatter: {},
    body,
  };
}

async function itemCount(seed: Seed, path: string): Promise<number> {
  const { data } = await db().from("items").select("id").eq("team_id", seed.teamId).eq("path", path);
  return (data ?? []).length;
}

describe("items route tier guard (real handler, real Postgres — the boundary lib/ingest itself never sees)", () => {
  it("rejects access='admin' with 422 forbidden_tier and writes NO item row", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const res = await post(team.key, seed.teamSlug, itemBody("admin", "5-personal/secret.md"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("forbidden_tier");
    expect(await itemCount(seed, "5-personal/secret.md")).toBe(0);
  });

  it("rejects access='private' with 422 forbidden_tier and writes NO item row", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const res = await post(team.key, seed.teamSlug, itemBody("private", "5-personal/notes.md"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("forbidden_tier");
    expect(await itemCount(seed, "5-personal/notes.md")).toBe(0);
  });

  it("rejects an unrecognized access tier with 422 invalid_payload and writes NO item row", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const res = await post(team.key, seed.teamSlug, itemBody("bogus-tier", "d/x.md"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");
    expect(await itemCount(seed, "d/x.md")).toBe(0);
  });

  it("accepts access='team' (201) and access='external' (201), each persisting with the requested tier", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");

    const teamRes = await post(team.key, seed.teamSlug, itemBody("team", "d/team-doc.md"));
    expect(teamRes.status).toBe(201);
    const extRes = await post(team.key, seed.teamSlug, itemBody("external", "d/client-doc.md"));
    expect(extRes.status).toBe(201);

    const { data: teamItem } = await db()
      .from("items")
      .select("access")
      .eq("team_id", seed.teamId)
      .eq("path", "d/team-doc.md")
      .single();
    const { data: extItem } = await db()
      .from("items")
      .select("access")
      .eq("team_id", seed.teamId)
      .eq("path", "d/client-doc.md")
      .single();
    expect((teamItem as { access: string }).access).toBe("team");
    expect((extItem as { access: string }).access).toBe("external");
  });

  // Attribution spoof gate: the route resolves author-from-frontmatter ONLY for trusted team-tier
  // keys. An external (client) key must NOT be able to attribute its content to a team member by
  // naming them in frontmatter — sole enforcement (no RLS backstop, §5).
  it("an EXTERNAL key cannot attribute content to a team member via frontmatter authors[]", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const ext = await issueKeyFor(seed, "external");
    // Give the team member a resolvable email, then have the external key name it as the author.
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: team.memberId, email: "victim@corp.com" });
    const authored = { ...itemBody("external", "d/spoof.md"), frontmatter: { source: "gdrive", authors: [{ role: "author", email: "victim@corp.com" }] } };

    const res = await post(ext.key, seed.teamSlug, authored);
    expect(res.status).toBe(201);
    const { data } = await db().from("items").select("member_id").eq("team_id", seed.teamId).eq("path", "d/spoof.md").single();
    // Attributed to the external PUSHER (actor), never the named team member.
    expect((data as { member_id: string }).member_id).toBe(ext.memberId);
    expect((data as { member_id: string }).member_id).not.toBe(team.memberId);
  });

  it("a TEAM key resolves a frontmatter author to a DIFFERENT member than the pusher (positive control)", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team"); // pusher = seed.memberId
    // A distinct real author on the roster (not the pushing key's member).
    const { data: author } = await db()
      .from("members")
      .insert({ team_id: seed.teamId, email: `auth-${randomUUID()}@test.local`, display_name: "Real Author", actor_handle: `ra-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active" })
      .select("id")
      .single();
    const authorId = (author as { id: string }).id;
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: authorId, email: "realauthor@corp.com" });
    const authored = { ...itemBody("team", "d/authored.md"), frontmatter: { source: "notion", authors: [{ role: "author", email: "realauthor@corp.com" }] } };

    const res = await post(team.key, seed.teamSlug, authored);
    expect(res.status).toBe(201);
    const { data } = await db().from("items").select("member_id").eq("team_id", seed.teamId).eq("path", "d/authored.md").single();
    expect((data as { member_id: string }).member_id).toBe(authorId); // resolved to the author, NOT the pusher
    expect((data as { member_id: string }).member_id).not.toBe(team.memberId);
  });

  it("legacy outward aliases ('client', 'company') normalize to external, not rejected", async () => {
    const seed = await seedTeam();
    const team = await issueKeyFor(seed, "team");
    const res = await post(team.key, seed.teamSlug, itemBody("client", "d/legacy-alias.md"));
    expect(res.status).toBe(201);
    const { data } = await db()
      .from("items")
      .select("access")
      .eq("team_id", seed.teamId)
      .eq("path", "d/legacy-alias.md")
      .single();
    expect((data as { access: string }).access).toBe("external");
  });
});
