import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { getCodebaseDetail } from "@/lib/metrics/codebases";
import { addAuthorAlias, removeAuthorAlias } from "@/lib/admin/aliases";
import { createMember } from "@/lib/admin/members";
import { codebaseScanPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";
import { fullMetrics } from "@/test/fixtures/codebase-scan";
import { repairAttributionNow } from "@/lib/ingest/reconcile-attribution";

const NOREPLY = "123+john@users.noreply.github.com";

/**
 * YESTERDAY, IN UTC — not a fixed date.
 *
 * `getCodebaseDetail` derives the `90d` window's lower bound from `Date.now()` and filters on the
 * contribution day, so a hard-coded seed day silently ages out of the window and the contributor
 * rows these tests assert on stop being returned at all. This is an identity/aliasing test, not a
 * date-boundary one: the seed only has to sit comfortably inside the requested window, and paired
 * alias identities must share the SAME day so aliasing collapses them onto one row.
 */
const recentDay = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function scan(slug: string, contributions: { author_key: string; author_email: string; day: string; commits: number }[]) {
  return codebaseScanPayloadSchema.parse({
    codebase: { slug, full_name: `acme/${slug}`, open_issues: 0 },
    metrics: fullMetrics({ commits_window: 8, ai_commits_window: 8, active_days: 3 }),
    contributions,
    issues: [],
  });
}

async function ingest(seed: { teamId: string; memberId: string }, payload: ReturnType<typeof scan>) {
  return ingestCodebaseScan(db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() }, payload);
}

describe("codebase contributor identity (real Postgres)", () => {
  it("aliasing collapses two git identities into one mapped contributor row (with avatar)", async () => {
    const seed = await seedTeam();
    const john = await createMember(db(), seed.teamId, {
      email: "john@john.test", displayName: "John Ellison", actorHandle: "john", role: "admin",
    });
    await db().from("members").update({ avatar_url: "https://avatars/x.png", github_login: "john" }).eq("id", john.id);

    const slug = `repo-${randomUUID().slice(0, 6)}`;
    const day = recentDay();
    await ingest(seed, scan(slug, [
      { author_key: "john@john.test", author_email: "john@john.test", day, commits: 5 },
      { author_key: NOREPLY, author_email: NOREPLY, day, commits: 3 },
    ]));

    // Before aliasing: the noreply identity is a separate unmapped row.
    let detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.contributors.length).toBe(2);
    expect(detail?.contributors.some((c) => c.member_id === null)).toBe(true);

    // After aliasing the noreply identity → one mapped row, avatar surfaced.
    const r = await addAuthorAlias(db(), seed.teamId, john.id, NOREPLY);
    expect(r.backfilled).toBe(1);
    detail = await getCodebaseDetail(db(), seed.teamId, slug, "90d", "team");
    expect(detail?.contributors.length).toBe(1);
    const row = detail!.contributors[0];
    expect(row.member_id).toBe(john.id);
    expect(row.member_name).toBe("John Ellison");
    expect(row.avatar_url).toBe("https://avatars/x.png");
    expect(row.commits).toBe(8); // 5 + 3 collapsed
  });

  it("the same alias cannot map to two members; remap requires force", async () => {
    const seed = await seedTeam();
    const a = await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "A", actorHandle: "aa", role: "member" });
    const b = await createMember(db(), seed.teamId, { email: "b@x.test", displayName: "B", actorHandle: "bb", role: "member" });

    const first = await addAuthorAlias(db(), seed.teamId, a.id, NOREPLY);
    expect(first.aliased).toBe(true);

    // claiming the same alias for B without force → collision, no change
    const collide = await addAuthorAlias(db(), seed.teamId, b.id, NOREPLY);
    expect(collide.collisions).toBeGreaterThan(0);
    const { data: stillA } = await db()
      .from("member_emails").select("member_id").eq("team_id", seed.teamId).eq("email", NOREPLY).maybeSingle();
    expect((stillA as { member_id: string }).member_id).toBe(a.id);

    // with force → remapped to B
    const forced = await addAuthorAlias(db(), seed.teamId, b.id, NOREPLY, { force: true });
    expect(forced.aliased).toBe(true);
    const { data: nowB } = await db()
      .from("member_emails").select("member_id").eq("team_id", seed.teamId).eq("email", NOREPLY).maybeSingle();
    expect((nowB as { member_id: string }).member_id).toBe(b.id);
  });

  it("does not silently re-point contributions already mapped to another member", async () => {
    const seed = await seedTeam();
    await createMember(db(), seed.teamId, { email: "a@x.test", displayName: "A", actorHandle: "aa", role: "member" });
    const b = await createMember(db(), seed.teamId, { email: "b@x.test", displayName: "B", actorHandle: "bb", role: "member" });
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingest(seed, scan(slug, [{ author_key: "a@x.test", author_email: "a@x.test", day: recentDay(), commits: 4 }]));
    // contribution is mapped to A (matches A's email). Try to claim it for B.
    const noForce = await addAuthorAlias(db(), seed.teamId, b.id, "a@x.test");
    expect(noForce.collisions).toBeGreaterThan(0);
    expect(noForce.remapped).toBe(0);
    const forced = await addAuthorAlias(db(), seed.teamId, b.id, "a@x.test", { force: true });
    expect(forced.remapped).toBeGreaterThan(0);
  });

  it("a verified alias unlink atomically clears its unlocked contribution credit", async () => {
    const seed = await seedTeam();
    const author = await createMember(db(), seed.teamId, {
      email: "alias-owner@x.test", displayName: "Alias Owner", actorHandle: "alias-owner", role: "member",
    });
    const email = `unlink-${randomUUID()}@users.noreply.github.com`;
    await addAuthorAlias(db(), seed.teamId, author.id, email);
    const slug = `repo-${randomUUID().slice(0, 6)}`;
    await ingest(seed, scan(slug, [{
      author_key: email, author_email: email, day: new Date().toISOString().slice(0, 10), commits: 2,
    }]));
    expect((await db().from("code_contributions").select("member_id")
      .eq("team_id",seed.teamId).eq("author_key",email).single()).data)
      .toMatchObject({member_id:author.id});

    expect(await removeAuthorAlias(db(),seed.teamId,email)).toEqual({removed:true});
    expect((await db().from("code_contributions").select("member_id")
      .eq("team_id",seed.teamId).eq("author_key",email).single()).data)
      .toMatchObject({member_id:null});
  });

  it("revision-fences a paused internal contribution writer after a completed alias remap", async () => {
    const seed=await seedTeam();
    const alice=await createMember(db(),seed.teamId,{
      email:"fence-a@x.test",displayName:"Fence A",actorHandle:`fence-a-${randomUUID()}`,role:"member",
    });
    const bob=await createMember(db(),seed.teamId,{
      email:"fence-b@x.test",displayName:"Fence B",actorHandle:`fence-b-${randomUUID()}`,role:"member",
    });
    const author=`fenced-${randomUUID()}@users.noreply.github.com`;
    await addAuthorAlias(db(),seed.teamId,alice.id,author);
    await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:10,batchSize:10});
    const slug=`repo-fence-${randomUUID().slice(0,6)}`;
    const payload=scan(slug,[{
      author_key:author,author_email:author,day:new Date().toISOString().slice(0,10),commits:3,
    }]);

    let release!:()=>void;
    let ready!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const snapshotted=new Promise<void>((resolve)=>{ready=resolve;});
    const paused=ingestCodebaseScan(
      db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},payload,
      {afterIdentitySnapshot:async()=>{ready();await gate;}},
    );
    await snapshotted;

    const remap=await addAuthorAlias(db(),seed.teamId,bob.id,author,{force:true});
    expect(remap.remapped).toBeGreaterThanOrEqual(0);
    const repaired=await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:10,batchSize:10});
    expect(repaired.partial).toBe(false);
    release();
    await expect(paused).rejects.toThrow(/identity mapping changed/);
    expect((await db().from("code_contributions").select("id")
      .eq("team_id",seed.teamId).eq("author_key",author)).data).toEqual([]);

    await ingest(seed,payload);
    expect((await db().from("code_contributions").select("member_id")
      .eq("team_id",seed.teamId).eq("author_key",author).single()).data)
      .toMatchObject({member_id:bob.id});
  });
});
