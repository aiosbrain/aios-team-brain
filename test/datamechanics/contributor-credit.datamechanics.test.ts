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

/**
 * Spec for SLACK credit on real Postgres. A thread is ONE item whose body is rewritten on every new
 * reply, and every version is stamped with the thread-ROOT author — so the version ledger says the root
 * did all the work. The observable bug: someone posts a one-line question, a colleague writes the
 * substantive replies, and the replier is credited NOWHERE (arcs, credit oracle, admin drill-down all
 * read this one function). The `participants[]` ledger is the honest record and must drive credit.
 */
async function addSlackIdentity(seed: Seed, memberId: string, slackUserId: string): Promise<void> {
  const { error } = await db()
    .from("member_identities")
    .insert({ team_id: seed.teamId, member_id: memberId, provider: "slack", external_id: slackUserId });
  if (error) throw new Error(`addSlackIdentity failed: ${error.message}`);
}

function slackPayload(
  body: string,
  path: string,
  participants: { author_id: string; last_ts: string }[]
): ItemPayload {
  return {
    project: "slack",
    kind: "transcript",
    actor: "slack-sync",
    frontmatter: { source: "slack", author_id: participants[0]?.author_id ?? "", participants },
    content_sha256: sha(body),
    body,
    path,
  } as ItemPayload;
}

describe("resolveItemCredit — Slack threads credit every participant, not just the root", () => {
  it("credits a REPLIER whose messages only ever produced root-stamped versions", async () => {
    const seed = await seedTeam(); // root author = "Tester"
    const root = seed.memberId;
    const replier = await addMember(seed, "Replier");
    await addSlackIdentity(seed, root, "UROOT");
    await addSlackIdentity(seed, replier, "UREPLY");
    const auth = { teamId: seed.teamId, memberId: root, apiKeyId: randomUUID() };
    const path = `slack/general/${randomUUID()}.md`;

    // v1: the root's one-line question. Every version is attributed to the ROOT (as the connector does).
    const first = await ingestItem(
      db(), auth,
      slackPayload("root question", path, [{ author_id: "UROOT", last_ts: "2026-07-01T10:00:00Z" }]),
      "team", { authorMemberId: root }
    );
    // v2: the replier's substantive answer rewrites the thread — still stamped to the ROOT.
    await ingestItem(
      db(), auth,
      slackPayload("root question\nreplier's long answer", path, [
        { author_id: "UROOT", last_ts: "2026-07-01T10:00:00Z" },
        { author_id: "UREPLY", last_ts: "2026-07-02T10:00:00Z" },
      ]),
      "team", { authorMemberId: root }
    );

    const c = (await resolveItemCredit(db(), seed.teamId, [first.id])).get(first.id)!;
    expect(new Set(c.contributors)).toEqual(new Set(["Tester", "Replier"])); // the replier is NOT invisible
    // PRIMARY is unchanged by this fix: the root owns the thread AND genuinely contributed (the root
    // message), so they stay the single balancing representative — same rule as every other source.
    // Only the CONTRIBUTOR set was wrong before, and that's what H1 was about.
    expect(c.primary).toBe("Tester");
  });

  it("still credits a mapped replier when the thread ROOT doesn't map to a member", async () => {
    // A thread started by someone outside the roster (or an unmapped Slack id) previously credited
    // NOBODY. The participants ledger still names the mapped replier, so their work is no longer lost.
    const seed = await seedTeam();
    const replier = await addMember(seed, "Only Replier");
    await addSlackIdentity(seed, replier, "UREPLY3");
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const path = `slack/general/${randomUUID()}.md`;
    const res = await ingestItem(
      db(), auth,
      slackPayload("outsider question\nreplier answer", path, [
        { author_id: "UNMAPPED_ROOT", last_ts: "2026-07-01T10:00:00Z" },
        { author_id: "UREPLY3", last_ts: "2026-07-02T10:00:00Z" },
      ]),
      "team", { authorMemberId: null } // root unresolved → honestly unattributed owner
    );

    const c = (await resolveItemCredit(db(), seed.teamId, [res.id])).get(res.id)!;
    expect(c.contributors).toEqual(["Only Replier"]); // the work is credited
    // PRIMARY stays null: the pure rule is "no current owner → unattributed for balancing", shared by
    // every source, and this PR deliberately doesn't widen it. So an owner-less thread credits its
    // contributors but represents nobody in arc balancing — a real remaining gap, tracked separately.
    expect(c.primary).toBeNull();
  });

  it("a LOCKED admin correction still wins over the participants ledger", async () => {
    const seed = await seedTeam();
    const root = seed.memberId;
    const replier = await addMember(seed, "Replier2");
    await addSlackIdentity(seed, root, "UROOT2");
    await addSlackIdentity(seed, replier, "UREPLY2");
    const auth = { teamId: seed.teamId, memberId: root, apiKeyId: randomUUID() };
    const path = `slack/general/${randomUUID()}.md`;
    const res = await ingestItem(
      db(), auth,
      slackPayload("q\na", path, [
        { author_id: "UROOT2", last_ts: "2026-07-01T10:00:00Z" },
        { author_id: "UREPLY2", last_ts: "2026-07-02T10:00:00Z" },
      ]),
      "team", { authorMemberId: root }
    );
    await db().from("items").update({ member_id: root, member_id_locked: true }).eq("id", res.id);

    const c = (await resolveItemCredit(db(), seed.teamId, [res.id])).get(res.id)!;
    expect(c.contributors).toEqual(["Tester"]); // the correction is authoritative
  });

  it("resolves a participant whose stored Slack id differs in CASE from the thread's", async () => {
    // Identities are stored case-preserved (an admin may type them by hand), and every other resolver
    // in the repo case-folds. A raw comparison here would drop that person from credit — resurrecting
    // this very bug per-identity, and flipping `primary` when it's the ROOT that mismatches.
    const seed = await seedTeam();
    const root = seed.memberId;
    const replier = await addMember(seed, "Cased Replier");
    await addSlackIdentity(seed, root, "uroot4"); // stored lower-case…
    await addSlackIdentity(seed, replier, "ureply4");
    const auth = { teamId: seed.teamId, memberId: root, apiKeyId: randomUUID() };
    const path = `slack/general/${randomUUID()}.md`;
    const res = await ingestItem(
      db(), auth,
      slackPayload("q\na", path, [
        { author_id: "UROOT4", last_ts: "2026-07-01T10:00:00Z" }, // …thread reports UPPER-case
        { author_id: "UREPLY4", last_ts: "2026-07-02T10:00:00Z" },
      ]),
      "team", { authorMemberId: root }
    );

    const c = (await resolveItemCredit(db(), seed.teamId, [res.id])).get(res.id)!;
    expect(new Set(c.contributors)).toEqual(new Set(["Tester", "Cased Replier"]));
    expect(c.primary).toBe("Tester"); // the root is still recognized → primary does NOT flip
  });

  it("falls back to the version ledger for a thread with no participants (pre-ledger items)", async () => {
    const seed = await seedTeam();
    const root = seed.memberId;
    const auth = { teamId: seed.teamId, memberId: root, apiKeyId: randomUUID() };
    const path = `slack/general/${randomUUID()}.md`;
    const res = await ingestItem(db(), auth, slackPayload("old thread", path, []), "team", { authorMemberId: root });
    const c = (await resolveItemCredit(db(), seed.teamId, [res.id])).get(res.id)!;
    expect(c.contributors).toEqual(["Tester"]);
  });
});
