import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * Spec: when a data source reassigns an item from one person to another, the re-push (SAME body, only the
 * frontmatter assignee changed) is recognized as the SAME item with a NEW owner — `items.member_id`
 * re-points and an `item.reassigned` audit row records the A→B transition. A LOCKED correction is never
 * reverted by such a re-push. Real Postgres (append-only audit trigger + real member_id write).
 */

async function addMember(seed: Seed, name: string): Promise<string> {
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

async function memberOf(id: string): Promise<string | null> {
  const { data } = await db().from("items").select("member_id").eq("id", id).single();
  return (data as { member_id: string | null } | null)?.member_id ?? null;
}

async function reassignAudits(teamId: string, itemId: string): Promise<{ from: string; to: string }[]> {
  const { data } = await db()
    .from("audit_log")
    .select("meta")
    .eq("team_id", teamId)
    .eq("action", "item.reassigned")
    .eq("target_id", itemId);
  // Project to {from,to} — the meta also carries `source`, asserted separately where it matters.
  return ((data ?? []) as { meta: { from: string; to: string } }[]).map((r) => ({ from: r.meta.from, to: r.meta.to }));
}

describe("source reassignment on re-push (real Postgres)", () => {
  it("re-points member_id A→B on an UNCHANGED re-push and logs item.reassigned", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const p = payload("issue body — unchanged prose", `linear/${randomUUID()}.md`);

    // First push: the connector resolves the author to A.
    const first = await ingestItem(db(), auth, p, "team", { authorMemberId: a });
    expect(first.status).toBe("created");
    expect(await memberOf(first.id)).toBe(a);

    // Reassigned in the source: SAME body (content_sha256 matches → unchanged path), new resolved owner B.
    const second = await ingestItem(db(), auth, p, "team", { authorMemberId: b });
    expect(second.status).toBe("unchanged"); // recognized as the SAME item
    expect(await memberOf(second.id)).toBe(b); // …just with a new owner
    expect(await reassignAudits(seed.teamId, first.id)).toEqual([{ from: a, to: b }]);
    // The transition captures WHICH source drove it + that it was author-signal-driven (a true source
    // reassignment, not a pusher-takeover) — the "why did this move?" trail.
    const { data: full } = await db()
      .from("audit_log")
      .select("meta")
      .eq("team_id", seed.teamId)
      .eq("action", "item.reassigned")
      .eq("target_id", first.id)
      .single();
    const meta = (full as { meta: { source: string; via: string; from_owned_since?: string } }).meta;
    expect(meta).toMatchObject({ source: "linear", via: "author_signal" });
    // The outgoing owner's window start is the item.created audit's timestamp (A owned it from creation) —
    // pin the VALUE, so a regression that anchors to the wrong event (e.g. item.updated) fails.
    const { data: created } = await db()
      .from("audit_log")
      .select("created_at")
      .eq("team_id", seed.teamId)
      .eq("action", "item.created")
      .eq("target_id", first.id)
      .single();
    expect(typeof meta.from_owned_since).toBe("string");
    expect(new Date(meta.from_owned_since!).getTime()).toBe(new Date((created as { created_at: string }).created_at).getTime());

    // A THIRD identical push once converged is a NO-OP — no per-tick re-audit (guards the M4 growth concern).
    const third = await ingestItem(db(), auth, p, "team", { authorMemberId: b });
    expect(third.status).toBe("unchanged");
    expect(await reassignAudits(seed.teamId, first.id)).toEqual([{ from: a, to: b }]); // still exactly one
  });

  it("re-points + logs on a CONTENT-changed reassignment too (body edited AND owner moved)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const path = `linear/${randomUUID()}.md`;

    const first = await ingestItem(db(), auth, payload("v1 body", path), "team", { authorMemberId: a });
    const second = await ingestItem(db(), auth, payload("v2 body — edited", path), "team", { authorMemberId: b });
    expect(second.status).toBe("updated");
    expect(await memberOf(first.id)).toBe(b);
    expect(await reassignAudits(seed.teamId, first.id)).toEqual([{ from: a, to: b }]);
  });

  it("NEVER reverts a LOCKED correction on a source re-push (the lock is the guard)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B");
    const auth = { teamId: seed.teamId, memberId: a, apiKeyId: randomUUID() };
    const p = payload("locked issue body", `linear/${randomUUID()}.md`);

    const first = await ingestItem(db(), auth, p, "team", { authorMemberId: a });
    // An admin deliberately corrected + locked this attribution.
    const { error } = await db().from("items").update({ member_id_locked: true }).eq("id", first.id);
    if (error) throw new Error(`lock failed: ${error.message}`);

    const second = await ingestItem(db(), auth, p, "team", { authorMemberId: b });
    expect(second.status).toBe("unchanged");
    expect(await memberOf(first.id)).toBe(a); // untouched — the source did NOT override the correction
    expect(await reassignAudits(seed.teamId, first.id)).toEqual([]); // nothing logged
  });
});
