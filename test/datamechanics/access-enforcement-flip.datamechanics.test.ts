import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as itemsGET, POST as itemsPOST } from "@/app/api/v1/items/route";
import { db, ingest, sha, seedTeam, type Seed } from "./helpers";
import { issueApiKey } from "@/lib/admin/keys";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import {
  assessEnforcementReadiness,
  readAccessEnforcement,
  setAccessEnforcement,
} from "@/lib/admin/access-enforcement";

/**
 * The OPERATOR surface for `teams.access_enforcement` (spec §5/§11).
 *
 * `lib/access/enforce.ts` and its slice tests already prove what an enforcing read *does*. What
 * nothing proved — because nothing outside a test could write the column — is what happens when a
 * real operator arms it on a real team, and that is the whole risk: a brain in the field has never
 * run `ensureAccessBootstrap` or the §11 backfill against a corpus that predates them, so the naive
 * flip (a raw UPDATE, the only method that existed) hides EVERY item from EVERY member.
 *
 * These are the assertions the command is built from:
 *   1. the naive flip really does blind a team (the failure being prevented — asserted, not assumed);
 *   2. `setAccessEnforcement` prepares first and therefore does not;
 *   3. enforcing ALONE does not separate teammates — day-one topology is byte-identical to today,
 *      which is the honest scope of what an operator is buying;
 *   4. a restricted project is the mechanism that actually separates them, and the flag is what
 *      makes that restriction bite;
 *   5. `admin`-tier content is refused at the boundary in either mode.
 */

function getReq(key: string): NextRequest {
  return new Request("http://test/api/v1/items", { headers: { authorization: `Bearer ${key}` } }) as unknown as NextRequest;
}

/** The paths a principal actually receives through the ENFORCED read path. */
async function paths(key: string): Promise<string[]> {
  const res = await itemsGET(getReq(key));
  expect(res.status).toBe(200);
  return ((await res.json()).items as { path: string }[]).map((i) => i.path);
}

async function memberKey(seed: Seed, memberId: string): Promise<string> {
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "k");
  return key;
}

/** A second team-tier human — the "other member of the client's team". */
async function seedMember(seed: Seed, over: { tier?: string; kind?: string } = {}): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "M",
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      kind: over.kind ?? "human",
      status: "active",
    })
    .select("id")
    .single();
  return data!.id as string;
}

/** The ONLY way to arm enforcement before this command existed: a raw write, no preparation. */
async function rawFlip(seed: Seed, mode: string) {
  await db().from("teams").update({ access_enforcement: mode }).eq("id", seed.teamId);
}

/** Two team-tier members, each with one pushed item — a client team on day one. */
async function seedTwoMemberTeam(): Promise<{ seed: Seed; memberB: string }> {
  const seed = await seedTeam();
  const memberB = await seedMember(seed);
  await ingest(seed, { path: "a-work.md", body: "A's work", access: "team", project: "src" });
  await ingest({ ...seed, memberId: memberB }, { path: "b-work.md", body: "B's work", access: "team", project: "src" });
  return { seed, memberB };
}

describe("access enforcement — arming the flag on a real team", () => {
  it("permissive (today): member A reads member B's pushed item — one flat team-tier pool", async () => {
    const { seed } = await seedTwoMemberTeam();
    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("permissive");
    const got = await paths(await memberKey(seed, seed.memberId));
    expect(got).toContain("a-work.md");
    expect(got, "a team-tier member sees every other member's content today").toContain("b-work.md");
  });

  it("the NAIVE flip (raw SQL, no preparation) blinds everyone — the outcome this command exists to prevent", async () => {
    const { seed } = await seedTwoMemberTeam();
    await rawFlip(seed, "enforcing");
    expect(
      await paths(await memberKey(seed, seed.memberId)),
      "an un-partitioned corpus fails CLOSED — the member loses their OWN work too"
    ).toEqual([]);
  });

  it("readiness refuses that team, and says why", async () => {
    const { seed } = await seedTwoMemberTeam();
    const r = await assessEnforcementReadiness(db(), seed.teamId);
    expect(r.ready).toBe(false);
    expect(r.unpartitioned.count).toBe(2);
    expect(r.unpartitioned.examples.sort()).toEqual(["a-work.md", "b-work.md"]);
    expect(r.blockers.join(" ")).toMatch(/no current project membership/);
  });

  it("setAccessEnforcement prepares first, so arming does NOT lock anyone out of their own content", async () => {
    const { seed, memberB } = await seedTwoMemberTeam();
    const res = await setAccessEnforcement(db(), seed.teamId, "enforcing");
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    // The mode reported is the one read BACK off the row, not the one requested.
    expect(res.mode).toBe("enforcing");
    expect(res.changed).toBe(true);
    expect(res.prepared?.membershipsCreated).toBe(2);
    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("enforcing");

    expect(await paths(await memberKey(seed, seed.memberId))).toContain("a-work.md");
    expect(await paths(await memberKey(seed, memberB))).toContain("b-work.md");
  });

  it("enforcing ALONE does not separate teammates — §11 day-one visibility is byte-identical to permissive", async () => {
    // The load-bearing honesty check. An operator arming the flag on a stock team gets the SAME
    // flat pool they had before: General↔Everyone is the bootstrap topology, so A still reads B.
    // Anyone who reads "access enforcement is on" as "members are now separated" is wrong, and
    // this test is where that claim goes to die.
    const { seed } = await seedTwoMemberTeam();
    expect((await setAccessEnforcement(db(), seed.teamId, "enforcing")).ok).toBe(true);
    const got = await paths(await memberKey(seed, seed.memberId));
    expect(got).toContain("a-work.md");
    expect(got, "day-one enforcing still shows a teammate's General content").toContain("b-work.md");
  });

  it("a restricted project is what actually hides B's item from A — and the flag is what makes it bite", async () => {
    const { seed, memberB } = await seedTwoMemberTeam();
    expect((await setAccessEnforcement(db(), seed.teamId, "enforcing")).ok).toBe(true);

    // Move B's item into a project granted only to a group B is in and A is not. (Curation UI is
    // Phase D; the edges are written through the single writer here, as the slice tests do.)
    const { data: restricted } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "b-private", name: "B private", kind: "initiative" })
      .select("id")
      .single();
    const g = await createGroup(db(), seed.teamId, "b-only", "B only", memberB);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, memberB, memberB);
    await grantProjectToGroup(db(), seed.teamId, restricted!.id, g.groupId!, memberB);
    const bItemId = (await db().from("items").select("id").eq("path", "b-work.md").eq("team_id", seed.teamId).single()).data!.id;
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", bItemId).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    await db()
      .from("project_context_memberships")
      .insert({ team_id: seed.teamId, project_id: restricted!.id, context_unit_id: unit!.id, method: "manual" });

    const aPaths = await paths(await memberKey(seed, seed.memberId));
    expect(aPaths, "A keeps their own General content — not the empty short-circuit").toContain("a-work.md");
    expect(aPaths, "A must not see the restricted item under enforcing").not.toContain("b-work.md");
    expect(await paths(await memberKey(seed, memberB)), "B still reads their own restricted work").toContain("b-work.md");

    // …and the flag is genuinely the gate: back to permissive and the same restriction stops applying.
    const back = await setAccessEnforcement(db(), seed.teamId, "permissive");
    expect(back.ok).toBe(true);
    expect(back.mode).toBe("permissive");
    expect(
      await paths(await memberKey(seed, seed.memberId)),
      "permissive ignores the project restriction entirely — tier is the only filter"
    ).toContain("b-work.md");
  });

  it("permissive is unconditional — the one-command undo for a team someone bricked by hand", async () => {
    const { seed } = await seedTwoMemberTeam();
    await rawFlip(seed, "enforcing"); // bricked: no bootstrap, no backfill
    expect(await paths(await memberKey(seed, seed.memberId))).toEqual([]);
    const res = await setAccessEnforcement(db(), seed.teamId, "permissive");
    expect(res.ok, "the fail-open direction is never gated on readiness").toBe(true);
    expect(res.mode).toBe("permissive");
    expect(await paths(await memberKey(seed, seed.memberId))).toContain("a-work.md");
  });

  it("a dry run on a stock team refuses, names BOTH blockers, and writes nothing", async () => {
    // What `--dry-run` actually prints against a brain in the field today: no bootstrap has ever
    // run, so every member is blind AND every item is unpartitioned. Dry run skips preparation by
    // design — the question it answers is "is this safe RIGHT NOW", not "could it be made safe".
    const { seed, memberB } = await seedTwoMemberTeam();
    const res = await setAccessEnforcement(db(), seed.teamId, "enforcing", { dryRun: true });
    expect(res.ok).toBe(false);
    expect(res.readiness?.ready).toBe(false);
    expect(res.readiness?.blindHumans.map((m) => m.memberId).sort()).toEqual([seed.memberId, memberB].sort());
    expect(res.readiness?.unpartitioned.count).toBe(2);
    expect(res.error).toMatch(/would see NOTHING under enforcing/);
    expect(res.error).toMatch(/no current project membership/);
    expect(res.prepared, "a dry run must not have run the bootstrap or the backfill").toBeUndefined();
    expect(
      await readAccessEnforcement(db(), seed.teamId),
      "a refused flip must leave the flag exactly as it was"
    ).toBe("permissive");
  });

  it("readiness names a member who has fallen out of the built-in group — they would see nothing", async () => {
    // The blind-human BLOCKER's own proof. `syncBuiltinMembership` is a read-then-write diff with
    // no serialization (documented in lib/access/groups.ts), so a member missing from Everyone is a
    // real state, not a hypothetical — and under enforcing it costs them everything.
    const { seed, memberB } = await seedTwoMemberTeam();
    expect((await setAccessEnforcement(db(), seed.teamId, "enforcing")).ok).toBe(true);
    const { data: everyone } = await db()
      .from("groups")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", "everyone")
      .single();
    await db().from("group_members").delete().eq("group_id", everyone!.id).eq("member_id", memberB);

    const r = await assessEnforcementReadiness(db(), seed.teamId);
    expect(r.ready).toBe(false);
    expect(r.blindHumans.map((m) => m.memberId)).toEqual([memberB]);
    expect(r.unpartitioned.count, "the corpus is fine — this blocker is about PEOPLE").toBe(0);
    // Not a theory: B's reads really are empty in that state.
    expect(await paths(await memberKey(seed, memberB))).toEqual([]);
  });

  it("an unplaced AGENT is a warning, not a blocker — agents are never auto-admitted", async () => {
    const { seed } = await seedTwoMemberTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const res = await setAccessEnforcement(db(), seed.teamId, "enforcing");
    expect(res.ok).toBe(true);
    expect(res.readiness?.unplacedAgents.map((m) => m.memberId)).toEqual([agent]);
    expect(res.readiness?.warnings.join(" ")).toMatch(/agent member\(s\) are in no granted group/);
    // The warning is TRUE, not decorative: the agent's own reads really do come back empty.
    expect(await paths(await memberKey(seed, agent))).toEqual([]);
  });

  it("admin-tier content is refused at the boundary with a 422 in BOTH modes — enforcement never touches it", async () => {
    const { seed } = await seedTwoMemberTeam();
    const key = await memberKey(seed, seed.memberId);
    const push = async () => {
      const body = "private notes";
      const req = new Request("http://test/api/v1/items", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          project: "src",
          path: "5-personal/notes.md",
          kind: "note",
          actor: "tester",
          access: "admin",
          frontmatter: {},
          body,
          content_sha256: sha(body),
        }),
      }) as unknown as NextRequest;
      return itemsPOST(req);
    };

    expect((await push()).status, "permissive").toBe(422);
    expect((await setAccessEnforcement(db(), seed.teamId, "enforcing")).ok).toBe(true);
    expect((await push()).status, "enforcing").toBe(422);
    const { data } = await db().from("items").select("id").eq("team_id", seed.teamId).eq("path", "5-personal/notes.md");
    expect(data ?? [], "admin-tier content never reaches the database at all").toEqual([]);
  });
});
