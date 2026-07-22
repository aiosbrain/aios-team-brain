import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { resolveContributorsByItem } from "@/lib/attribution/contributor-credit";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * Spec: `resolveContributorsByItem` credits everyone who produced a version (real work) on an item — so a
 * prior contributor survives a reassignment — with connectors excluded and a locked correction collapsing
 * credit to the corrected owner. Verified against real item_versions (the work ledger). See
 * docs/design/attribution-ownership-timeline.md.
 */

async function addMember(seed: Seed, name: string, connector = false): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: name,
      actor_handle: `h-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      is_connector: connector,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addMember failed: ${error?.message}`);
  return (data as { id: string }).id;
}

function payload(body: string, path: string): ItemPayload {
  return {
    project: "acme",
    kind: "deliverable",
    actor: "connector",
    frontmatter: { source: "linear" },
    content_sha256: sha(body),
    body,
    path,
  } as ItemPayload;
}

describe("resolveContributorsByItem (real Postgres item_versions)", () => {
  it("credits BOTH authors of a handed-off item (A worked, then reassigned to B who also worked)", async () => {
    const seed = await seedTeam(); // A = "Tester"
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: a }); // version by A
    await ingestItem(db(), auth, payload("v2 edited", path), "team", { authorMemberId: b }); // version by B (reassigned)

    const map = await resolveContributorsByItem(db(), seed.teamId, [first.id]);
    expect(new Set(map.get(first.id))).toEqual(new Set(["Tester", "Person B"])); // A NOT erased
  });

  it("still credits the prior worker after a PURE reassignment (owner is B now, but only A ever worked)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1 only", path), "team", { authorMemberId: a }); // A's version
    await db().from("items").update({ member_id: b }).eq("id", first.id); // pure reassignment (no new version)

    const map = await resolveContributorsByItem(db(), seed.teamId, [first.id]);
    expect(map.get(first.id)).toEqual(["Tester"]); // credited to who actually worked, not the new owner
  });

  it("LOCKED correction collapses credit to the corrected owner (evidence overridden)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: a }); // A's version
    // Admin asserts it was always B's (a mislabel) — corrected + locked.
    await db().from("items").update({ member_id: b, member_id_locked: true }).eq("id", first.id);

    const map = await resolveContributorsByItem(db(), seed.teamId, [first.id]);
    expect(map.get(first.id)).toEqual(["Person B"]); // A's version credit is suppressed by the lock
  });

  it("falls back to the human current owner when the item's ONLY version author is a connector", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const connector = await addMember(seed, "Notion Sync", true);
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    // A connector authored the only version; then the item was re-pointed to a real human owner.
    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: connector });
    await db().from("items").update({ member_id: a }).eq("id", first.id);

    const map = await resolveContributorsByItem(db(), seed.teamId, [first.id]);
    expect(map.get(first.id)).toEqual(["Tester"]); // connector version excluded → fallback to the owner
  });

  it("excludes connector version authors (a sync account never earns credit)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const connector = await addMember(seed, "Notion Sync", true);
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: a }); // A's version
    // A connector-authored version lands too (e.g. a service-account edit).
    const { error } = await db()
      .from("item_versions")
      .insert({ item_id: first.id, content_sha256: sha("conn"), body: "conn", member_id: connector });
    if (error) throw new Error(`version insert failed: ${error.message}`);

    const map = await resolveContributorsByItem(db(), seed.teamId, [first.id]);
    expect(map.get(first.id)).toEqual(["Tester"]); // connector excluded
  });
});
