import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { resolveItemCredit, resolveItemCreditIds } from "@/lib/attribution/contributor-credit";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * Spec: `resolveItemCredit` credits everyone who produced a version (real work) on an item — so a
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

describe("resolveItemCredit (real Postgres item_versions)", () => {
  it("credits BOTH authors of a handed-off item (A worked, then reassigned to B who also worked)", async () => {
    const seed = await seedTeam(); // A = "Tester"
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: a }); // version by A
    await ingestItem(db(), auth, payload("v2 edited", path), "team", { authorMemberId: b }); // version by B (reassigned)

    const c = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(new Set(c.contributors)).toEqual(new Set(["Tester", "Person B"])); // A NOT erased
    expect(c.primary).toBe("Person B"); // current owner B actually worked (latest) → balances under B
  });

  it("still credits the prior worker after a PURE reassignment (owner is B now, but only A ever worked)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1 only", path), "team", { authorMemberId: a }); // A's version
    await db().from("items").update({ member_id: b }).eq("id", first.id); // pure reassignment (no new version)

    const c = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(c.contributors).toEqual(["Tester"]);
    // The balancing fix: owner is B now, but B did NO work → primary is the actual worker A, so A's facts
    // balance under A (their own arc share), not the non-working new owner.
    expect(c.primary).toBe("Tester");
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

    const c = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(c.contributors).toEqual(["Person B"]); // A's version credit is suppressed by the lock
    expect(c.primary).toBe("Person B");
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

    const c = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(c.contributors).toEqual(["Tester"]); // connector version excluded → fallback to the owner
    expect(c.primary).toBe("Tester");
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

    const c = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(c.contributors).toEqual(["Tester"]); // connector excluded
  });
});

describe("resolveItemCreditIds (the ID oracle every surface reads)", () => {
  it("returns member IDs (contributorIds + primaryId) for a handed-off item", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;
    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: a });
    await ingestItem(db(), auth, payload("v2", path), "team", { authorMemberId: b });

    const c = (await resolveItemCreditIds(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(new Set(c.contributorIds)).toEqual(new Set([a, b]));
    expect(c.primaryId).toBe(b);
  });

  it("credits a HUMAN member with a BLANK display_name (via actor_handle) — was excluded before", async () => {
    const seed = await seedTeam();
    // A human whose display_name is empty (NOT NULL column, but blank) with a real handle.
    const { data, error } = await db().from("members").insert({
      team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "",
      actor_handle: `nameless-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active", is_connector: false,
    }).select("id, actor_handle").single();
    if (error || !data) throw new Error(`nameless member failed: ${error?.message}`);
    const nameless = (data as { id: string; actor_handle: string });
    const auth = { teamId: seed.teamId, memberId: nameless.id, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;
    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: nameless.id });

    const ids = (await resolveItemCreditIds(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(ids.contributorIds).toEqual([nameless.id]); // nameless human IS credited by id
    const names = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(names.contributors).toEqual([nameless.actor_handle]); // name projection falls back to handle
  });

  it("prefetched `items` option skips the items read and yields the same credit", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;
    const first = await ingestItem(db(), auth, payload("v1", path), "team", { authorMemberId: a });

    const viaPrefetch = (await resolveItemCreditIds(db(), seed.teamId, [first.id], {
      items: [{ id: first.id, member_id: a, member_id_locked: false }],
    })).get(first.id)!;
    expect(viaPrefetch.primaryId).toBe(a);
    expect(viaPrefetch.contributorIds).toEqual([a]);
  });
});
