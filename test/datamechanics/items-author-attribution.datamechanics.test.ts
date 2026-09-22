import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attributeIncomingItem } from "@/lib/attribution/resolve-authors";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { db, seedTeam, sha, type Seed } from "./helpers";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { drainIdentityRepairs } from "@/lib/ingest/identity-repair";
import { repairAttributionNow } from "@/lib/ingest/reconcile-attribution";

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

async function addMember(teamId:string,name:string):Promise<string>{
  const {data,error}=await db().from("members").insert({
    team_id:teamId,email:`${randomUUID()}@test.local`,display_name:name,
    actor_handle:`${name.toLowerCase().replaceAll(" ","-")}-${randomUUID().slice(0,8)}`,
    role:"member",tier:"team",status:"active",is_connector:false,
  }).select("id").single();
  if(error||!data) throw new Error(`addMember failed: ${error?.message}`);
  return (data as {id:string}).id;
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
  const res = await ingestItem(
    db(),
    { teamId: seed.teamId, memberId: actorMemberId, apiKeyId: randomUUID() },
    p,
    "team",
    opts,
    "team",
    undefined,
  );
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

  it("on an unchanged re-push: heals null→member, RE-POINTS a source reassignment (unlocked), never clears to null", async () => {
    // content_sha256 covers body+title only, so an author signal that changes in FRONTMATTER (late source
    // enrichment, or a Linear/Plane assignee reassignment) must still land on an unchanged re-push:
    //   • null → member = a heal;
    //   • member A → member B (UNLOCKED) = a source reassignment → re-point (the lock, tested below +
    //     in ingest-reassignment, is what protects a deliberate correction);
    //   • → null is NEVER auto-applied (an unassignment stays the manual batch's / mismatch-flag's job).
    const seed = await seedTeam();
    const other = await addConnector(seed.teamId); // any other member id to stand in as "a different author"
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const p = payload({ source: "notion" }); // one payload → identical sha across pushes
    const stored = async () =>
      ((await db().from("items").select("member_id").eq("id", r1.id).single()).data as { member_id: string | null }).member_id;

    const r1 = await ingestItem(db(), auth, p, "team", { authorMemberId: null }); // first ingest: unattributed
    expect(await stored()).toBeNull();

    const r2 = await ingestItem(db(), auth, p, "team", { authorMemberId: seed.memberId }); // unchanged + now resolved
    expect(r2.status).toBe("unchanged");
    expect(await stored()).toBe(seed.memberId); // null → healed

    await ingestItem(db(), auth, p, "team", { authorMemberId: other }); // unchanged, resolves to a DIFFERENT member
    expect(await stored()).toBe(other); // RE-POINTED — a source reassignment propagates (item not locked)

    await ingestItem(db(), auth, p, "team", { authorMemberId: null }); // unchanged, unresolved
    expect(await stored()).toBe(other); // NOT cleared to null
  });

  it("frontmatter heal refreshes changed keys but PRESERVES best-effort author keys the re-push omits", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const p1 = payload({ source: "github", state: "old", author: "Alice", author_email: "alice@corp.com", author_login: "alice" });
    const r1 = await ingestItem(db(), auth, p1, "team"); // first ingest WITH best-effort author keys
    const fmOf = async () =>
      ((await db().from("items").select("frontmatter").eq("id", r1.id).single()).data as { frontmatter: Record<string, unknown> }).frontmatter;

    // same body (unchanged) but a real key changed AND the author keys are omitted (transient lookup miss)
    const r2 = await ingestItem(db(), auth, { ...p1, frontmatter: { source: "github", state: "new" } }, "team");
    expect(r2.status).toBe("unchanged");
    const fm = await fmOf();
    expect(fm.state).toBe("new"); // real change healed
    expect(fm.author_email).toBe("alice@corp.com"); // best-effort author key PRESERVED, not wiped
    expect(fm.author).toBe("Alice");
  });

  it("rejects a stale mapping-derived override at the common item/version write boundary", async()=>{
    const seed=await seedTeam();
    const connector=await addConnector(seed.teamId);
    const bob=await addMember(seed.teamId,"Fence Bob");
    const externalId=`permission:${randomUUID()}`;
    const first=await setMemberIdentity(db(),seed.teamId,seed.memberId,{
      provider:"gdrive",externalId,email:"fence-author@example.com",
    });
    const existing=payload({
      source:"notion",authors:[{provider:"gdrive",external_id:externalId,role:"author"}],
    });
    const pOpts=(await attributeIncomingItem(db(),seed.teamId,existing,connector)).opts!;
    const auth={teamId:seed.teamId,memberId:connector,apiKeyId:randomUUID()};
    const created=await ingestItem(db(),auth,existing,"team",pOpts);

    await setMemberIdentity(db(),seed.teamId,bob,{
      provider:"gdrive",externalId,email:"fence-author@example.com",
    },{force:true,expectedRevision:first.mappingRevision});
    await drainIdentityRepairs(db(),{maxObligations:10,batchSize:50});
    await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:10,batchSize:50});
    expect((await db().from("team_identity_authority").select("repair_status")
      .eq("team_id",seed.teamId).single()).data).toMatchObject({repair_status:"complete"});
    expect((await db().from("items").select("member_id").eq("id",created.id).single()).data)
      .toMatchObject({member_id:bob});
    const versionsBefore=(await db().from("item_versions").select("id")
      .eq("item_id",created.id)).data?.length ?? 0;

    const changedBody=`changed ${randomUUID()}`;
    const changed={...existing,body:changedBody,content_sha256:sha(changedBody)};
    await expect(ingestItem(db(),auth,changed,"team",pOpts)).rejects.toThrow(/identity mapping changed/);
    expect((await db().from("items").select("body,member_id").eq("id",created.id).single()).data)
      .toMatchObject({body:existing.body,member_id:bob});
    expect((await db().from("item_versions").select("id").eq("item_id",created.id)).data?.length)
      .toBe(versionsBefore);

    const unseen=payload({
      source:"notion",authors:[{provider:"gdrive",external_id:externalId,role:"author"}],
    });
    await expect(ingestItem(db(),auth,unseen,"team",pOpts)).rejects.toThrow(/identity mapping changed/);
    expect((await db().from("items").select("id").eq("team_id",seed.teamId)
      .eq("path",unseen.path)).data).toEqual([]);

    const currentOpts=(await attributeIncomingItem(db(),seed.teamId,changed,connector)).opts!;
    await ingestItem(db(),auth,changed,"team",currentOpts);
    await ingestItem(db(),auth,unseen,"team",currentOpts);
    const {data:current}=await db().from("items").select("path,member_id")
      .eq("team_id",seed.teamId).in("path",[existing.path,unseen.path]);
    expect(current).toHaveLength(2);
    expect(current?.every((row)=>row.member_id===bob)).toBe(true);
    expect((await db().from("item_versions").select("member_id").eq("item_id",created.id)).data
      ?.every((row)=>row.member_id===bob)).toBe(true);
  });
});

/**
 * Spec: the never-connector invariant must also hold when a push carries NO author signal at all —
 * the common shape for web / Google Drive / Confluence documents, which often have no author field.
 * Previously the resolver returned early on an empty signal, so the item was attributed to the
 * PUSHER: a sync account claimed every author-less document it ingested, and because credit flows
 * from `items.member_id`, that content surfaced as a real person's work in their timeline and arcs.
 */
describe("author-less pushes (real Postgres)", () => {
  it("leaves a CONNECTOR's author-less document unattributed, never claimed by the sync account", async () => {
    const seed = await seedTeam();
    const connectorId = await addConnector(seed.teamId);
    const stored = await ingestAs(seed, connectorId, { source: "web" }); // no author key at all
    expect(stored).toBeNull();
  });

  it("still attributes a HUMAN's own author-less push to that human (it IS their work)", async () => {
    const seed = await seedTeam();
    const stored = await ingestAs(seed, seed.memberId, { source: "local" });
    expect(stored).toBe(seed.memberId);
  });
});
