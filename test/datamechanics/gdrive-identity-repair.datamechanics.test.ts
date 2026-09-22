import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, externalMember, ingest, seedTeam, type Seed } from "./helpers";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import {
  drainIdentityRepairs,
  runIdentityRepairObligation,
} from "@/lib/ingest/identity-repair";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { repairAttributionNow } from "@/lib/ingest/reconcile-attribution";
import type { DbClient } from "@/lib/db/types";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { authorizationEpoch } from "@/lib/access/authorization-epoch";
import {
  readTimelineCache,
  resolveTimelineVariant,
  writeTimelineCache,
} from "@/lib/dashboard/timeline-cache";
import { readArcCache, writeArcCache } from "@/lib/graph/arc-cache";

const EXTERNAL_ID = "permission:person-A";

async function member(seed: Seed, name: string, email = `${randomUUID()}@test.local`): Promise<string> {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId,
    email,
    display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member",
    tier: "team",
    status: "active",
    is_connector: false,
  }).select("id").single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function driveItem(seed: Seed, suffix: string, at = "2026-09-21T04:30:00-04:00") {
  const result = await ingest(seed, {
    project: "drive-repair",
    path: `gdrive/${suffix}-${randomUUID()}.md`,
    access: "team",
    body: `body ${suffix}`,
    frontmatter: {
      source: "gdrive",
      source_id: `doc-${suffix}`,
      source_url: `https://docs.google.com/document/d/doc-${suffix}/edit`,
      title: `Drive ${suffix}`,
      authors: [{
        provider: "gdrive",
        external_id: EXTERNAL_ID,
        email: "provider@example.com",
        role: "editor",
      }],
      contributions: [{
        external_id: EXTERNAL_ID,
        email: "provider@example.com",
        role: "editor",
        at,
      }],
    },
  });
  // The helper's direct ingest principal is only transport authority, not source authorship.
  await db().from("items").update({ member_id: null }).eq("id", result.id);
  await db().from("item_versions").update({ member_id: null }).eq("item_id", result.id);
  return result.id;
}

async function obligation(seed: Seed, revision: number) {
  const { data, error } = await db().from("identity_repair_obligations")
    .select("team_id,provider,external_id,mapping_revision,cursor_item_id,items_scanned,items_updated,versions_updated,contributions_updated")
    .eq("team_id", seed.teamId)
    .eq("provider", "gdrive")
    .eq("external_id", EXTERNAL_ID)
    .eq("mapping_revision", revision)
    .single();
  if (error || !data) throw new Error(`obligation read failed: ${error?.message}`);
  return data as Parameters<typeof runIdentityRepairObligation>[1];
}

/** Inject one supporting-read failure while leaving writes backed by the real Postgres client. */
function failingSelect(table: string, message: string): DbClient {
  const real = db();
  const injected = { data: null, error: { message } };
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const query = (target as { from: (n: string) => unknown }).from(name);
        if (name !== table) return query;
        const wrap = (builder: object): unknown => new Proxy(builder, {
          get(inner, key, receiver) {
            if (key === "then") return (resolve: (value: unknown) => unknown) => resolve(injected);
            const value = Reflect.get(inner, key, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const result = (value as (...params: unknown[]) => unknown).apply(inner,args);
              if (key === "single" || key === "maybeSingle") {
                return { then: (resolve: (value: unknown) => unknown) => resolve(injected) };
              }
              return result === inner ? receiver : wrap(result as object);
            };
          },
        });
        return wrap(query as object);
      };
    },
  }) as DbClient;
}

function failingDelete(table:string,message:string):DbClient{
  const real=db();
  return new Proxy(real as object,{
    get(target,prop,recv){
      if(prop!=="from") return Reflect.get(target,prop,recv);
      return (name:string)=>{
        const query=(target as {from:(n:string)=>unknown}).from(name) as object;
        if(name!==table) return query;
        return new Proxy(query,{
          get(inner,key,receiver){
            if(key!=="delete") return Reflect.get(inner,key,receiver);
            return ()=>({eq:async()=>({data:null,error:{message}})});
          },
        });
      };
    },
  }) as DbClient;
}

describe("AIO-1167 Drive identity repair (real Postgres)", () => {
  it("supports multiple exact Google namespaces while rejecting cross-team, connector, and deactivated targets", async () => {
    const seed = await seedTeam();
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "subject:Account-A", email: "one@example.com",
    });
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "subject:Account-B", email: "two@example.com",
    });
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "permission:Account-A", email: "one@example.com",
    });
    expect((await db().from("member_identities").select("external_id")
      .eq("team_id", seed.teamId).eq("provider", "gdrive")).data?.map((row) => row.external_id).sort())
      .toEqual(["permission:Account-A", "subject:Account-A", "subject:Account-B"]);

    const disabled = await member(seed, "Disabled");
    await db().from("members").update({ status: "disabled" }).eq("id", disabled);
    await expect(setMemberIdentity(db(), seed.teamId, disabled, {
      provider: "gdrive", externalId: "subject:disabled",
    })).rejects.toThrow(/deactivated/);

    const connector = await member(seed, "Connector");
    await db().from("members").update({ is_connector: true }).eq("id", connector);
    await expect(setMemberIdentity(db(), seed.teamId, connector, {
      provider: "gdrive", externalId: "subject:connector",
    })).rejects.toThrow(/connector service accounts/);

    const other = await seedTeam();
    await expect(setMemberIdentity(db(), seed.teamId, other.memberId, {
      provider: "gdrive", externalId: "subject:cross-team",
    })).rejects.toThrow(/not a member of this team/);
    await expect(setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "account:ambiguous-kind",
    })).rejects.toThrow(/verified subject/);
  });

  it("revision-fences restartable link/remap/unlink repairs and retained version credit", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice", "provider@example.com");
    const bob = await member(seed, "Bob");
    const itemA = await driveItem(seed, "a");
    const itemB = await driveItem(seed, "b");

    const linked = await setMemberIdentity(db(), seed.teamId, alice, {
      provider: "gdrive", externalId: EXTERNAL_ID, email: "provider@example.com",
    });
    await expect(setMemberIdentity(db(), seed.teamId, bob, {
      provider: "gdrive", externalId: EXTERNAL_ID,
    }, { force: true, expectedRevision: 0 })).rejects.toThrow(/changed concurrently/);
    const first = await obligation(seed, linked.mappingRevision!);
    expect(await runIdentityRepairObligation(db(), first, { batchSize: 1 }))
      .toMatchObject({ status: "partial", scanned: 1 });
    const persisted = await obligation(seed, linked.mappingRevision!);
    expect(persisted.cursor_item_id).toBeTruthy();
    expect(await runIdentityRepairObligation(db(), persisted, { batchSize: 10 }))
      .toMatchObject({ status: "complete", scanned: 1 });

    const { data: linkedItems } = await db().from("items").select("id,member_id")
      .in("id", [itemA, itemB]).order("id");
    expect(linkedItems?.map((row) => row.member_id)).toEqual([alice, alice]);
    const { data: linkedVersions } = await db().from("item_versions").select("member_id")
      .in("item_id", [itemA, itemB]);
    expect(linkedVersions?.every((row) => row.member_id === alice)).toBe(true);

    const remapped = await setMemberIdentity(db(), seed.teamId, bob, {
      provider: "gdrive", externalId: EXTERNAL_ID,
    }, { force: true, expectedRevision: linked.mappingRevision });
    const stale = await obligation(seed, linked.mappingRevision!);
    // Completed work stays completed; the current revision is the only mutable authority.
    expect(Number(stale.mapping_revision)).toBe(linked.mappingRevision);
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect((await db().from("items").select("member_id").eq("id", itemA).single()).data)
      .toMatchObject({ member_id: bob });

    const removed = await removeMemberIdentity(db(), seed.teamId, {
      provider: "gdrive", externalId: EXTERNAL_ID,
    }, { expectedRevision: remapped.mappingRevision });
    expect(removed.removed).toBe(true);
    await drainIdentityRepairs(db(), { maxObligations: 10, batchSize: 10 });
    expect((await db().from("items").select("member_id").eq("id", itemA).single()).data)
      .toMatchObject({ member_id: null });
    expect((await db().from("gdrive_contribution_evidence").select("member_id")
      .eq("team_id", seed.teamId)).data?.every((row) => row.member_id === null)).toBe(true);
  });

  it("a newer mapping obsoletes a stale worker and an explicit credit-nobody lock wins at read time", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice", "provider@example.com");
    const bob = await member(seed, "Bob");
    const itemId = await driveItem(seed, "locked");
    const first = await setMemberIdentity(db(), seed.teamId, alice, {
      provider: "gdrive", externalId: EXTERNAL_ID,
    });
    const stale = await obligation(seed, first.mappingRevision!);
    const second = await setMemberIdentity(db(), seed.teamId, bob, {
      provider: "gdrive", externalId: EXTERNAL_ID,
    }, { force: true, expectedRevision: first.mappingRevision });
    expect(await runIdentityRepairObligation(db(), stale)).toMatchObject({ status: "obsolete" });
    await drainIdentityRepairs(db(), { maxObligations: 10 });
    expect((await db().from("items").select("member_id").eq("id", itemId).single()).data)
      .toMatchObject({ member_id: bob });

    await db().from("items").update({ member_id: null, member_id_locked: true }).eq("id", itemId);
    await removeMemberIdentity(db(), seed.teamId, {
      provider: "gdrive", externalId: EXTERNAL_ID,
    }, { expectedRevision: second.mappingRevision });
    await drainIdentityRepairs(db(), { maxObligations: 10 });
    expect((await db().from("gdrive_contribution_evidence")
      .select("member_id,diagnostic").eq("item_id", itemId).single()).data)
      .toMatchObject({ member_id: null, diagnostic: "manual_credit_nobody" });
    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, {
      visibleItemIds: new Set([itemId]),
      visibleProjectIds: new Set(),
    });
    expect(days.flatMap((day) => day.people)
      .flatMap((person) => person.groups)
      .flatMap((group) => group.evidence)
      .some((evidence) => evidence.title === "Drive locked")).toBe(false);

    // The revision exists solely to prove the second mapping remained authoritative.
    expect(second.mappingRevision).toBeGreaterThan(first.mappingRevision!);
  });

  it("team revision fences a paused P snapshot after Q remaps the same item and all ledgers", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice P");
    const bob = await member(seed, "Bob Q");
    const itemId = await driveItem(seed, "pq-race");
    const first = await setMemberIdentity(db(), seed.teamId, alice, {
      provider: "gdrive", externalId: EXTERNAL_ID, email: "provider@example.com",
    });

    let releaseP!: () => void;
    let snapshotReady!: () => void;
    const paused = new Promise<void>((resolve) => { releaseP = resolve; });
    const ready = new Promise<void>((resolve) => { snapshotReady = resolve; });
    const workerP = reattributeItems(db(), seed.teamId, {
      batchSize: 10,
      afterSnapshot: async () => { snapshotReady(); await paused; },
    });
    await ready;

    await setMemberIdentity(db(), seed.teamId, bob, {
      provider: "gdrive", externalId: EXTERNAL_ID, email: "provider@example.com",
    }, { force: true, expectedRevision: first.mappingRevision });
    const workerQ = await repairAttributionNow(db(), seed.teamId, seed.teamSlug, {
      maxBatches: 10, batchSize: 10,
    });
    expect(workerQ.partial).toBe(false);
    releaseP();
    await expect(workerP).rejects.toThrow(/identity mapping changed/);

    expect((await db().from("items").select("member_id").eq("id", itemId).single()).data)
      .toMatchObject({ member_id: bob });
    expect((await db().from("item_versions").select("member_id").eq("item_id", itemId)).data
      ?.every((row) => row.member_id === bob)).toBe(true);
    const authority=(await db().from("team_identity_authority").select("repair_status,revision")
      .eq("team_id",seed.teamId).single()).data as {repair_status:string;revision:number};
    expect((await db().from("gdrive_contribution_evidence").select("member_id,authority_revision")
      .eq("item_id",itemId)).data?.every((row)=>(
        row.member_id===bob && Number(row.authority_revision)===Number(authority.revision)
      ))).toBe(true);
    expect(authority).toMatchObject({repair_status:"complete"});
  });

  it.each(["members","member_emails","member_identities","member_identity_mapping_state"])(
    "preserves item/version/contribution credit and pending repair when %s cannot be read",
    async (failedTable) => {
      const seed=await seedTeam();
      const alice=await member(seed,"Strict Alice");
      const bob=await member(seed,"Strict Bob");
      const itemId=await driveItem(seed,`strict-${failedTable}`);
      const first=await setMemberIdentity(db(),seed.teamId,alice,{
        provider:"gdrive",externalId:EXTERNAL_ID,email:"provider@example.com",
      });
      await drainIdentityRepairs(db(),{maxObligations:10,batchSize:10});
      await setMemberIdentity(db(),seed.teamId,bob,{
        provider:"gdrive",externalId:EXTERNAL_ID,email:"provider@example.com",
      },{force:true,expectedRevision:first.mappingRevision});

      await expect(reattributeItems(
        failingSelect(failedTable,`${failedTable} unavailable`),seed.teamId,
      )).rejects.toThrow(/failed|unavailable/);
      expect((await db().from("items").select("member_id").eq("id",itemId).single()).data)
        .toMatchObject({member_id:alice});
      expect((await db().from("item_versions").select("member_id").eq("item_id",itemId)).data
        ?.every((row)=>row.member_id===alice)).toBe(true);
      expect((await db().from("gdrive_contribution_evidence").select("member_id")
        .eq("item_id",itemId)).data?.every((row)=>row.member_id===alice)).toBe(true);
      expect((await db().from("team_identity_authority").select("repair_status,last_error")
        .eq("team_id",seed.teamId).single()).data).toMatchObject({
          repair_status:"retry",last_error:expect.stringContaining("unavailable"),
        });
    },
  );

  it("a concurrent credit-nobody correction wins over a paused mapping repair", async () => {
    const seed=await seedTeam();
    const alice=await member(seed,"Correction Alice");
    const itemId=await driveItem(seed,"correction-race");
    await setMemberIdentity(db(),seed.teamId,alice,{
      provider:"gdrive",externalId:EXTERNAL_ID,email:"provider@example.com",
    });
    await drainIdentityRepairs(db(),{maxObligations:10,batchSize:10});

    let release!:()=>void;
    let ready!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const snapshotted=new Promise<void>((resolve)=>{ready=resolve;});
    const repair=reattributeItems(db(),seed.teamId,{
      batchSize:10,afterSnapshot:async()=>{ready();await gate;},
    });
    await snapshotted;
    const correction=await applyAttributionCorrection(db(),seed.teamId,{
      kind:"reassign",match:{itemId},toMember:"nobody",
    },{memberId:seed.memberId},1);
    expect(correction.ok).toBe(true);
    release();
    await expect(repair).resolves.toMatchObject({partial:false});

    expect((await db().from("items").select("member_id,member_id_locked")
      .eq("id",itemId).single()).data).toMatchObject({member_id:null,member_id_locked:true});
    const currentRevision=Number((await db().from("team_identity_authority").select("revision")
      .eq("team_id",seed.teamId).single()).data?.revision);
    expect((await db().from("gdrive_contribution_evidence").select("member_id,diagnostic,authority_revision")
      .eq("item_id",itemId)).data?.every((row)=>(
        row.member_id===null && row.diagnostic==="manual_credit_nobody"
          && Number(row.authority_revision)===currentRevision
      ))).toBe(true);
  });

  it("invalidates every cache variant on alias/deactivation and fences an in-flight old-epoch publish",async()=>{
    const seed=await seedTeam();
    await driveItem(seed,"cache-epoch");
    // TIERRET-1: a cache row is addressed by its reader's admission variant, and a tier that
    // disagrees with the variant's posture is refused — so the external row needs a real external
    // reader. Minted before the repair below so the roster change is part of the healthy generation.
    const externalId=await externalMember(seed);
    // Complete the initial attribution work before constructing a healthy cache generation.
    await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:10,batchSize:20});
    const vis=await resolveTimelineVariant(db(),seed.teamId,seed.memberId);
    const externalVis=await resolveTimelineVariant(db(),seed.teamId,externalId);
    const oldEpoch=await authorizationEpoch(db(),seed.teamId);
    expect(await writeTimelineCache(db(),seed.teamId,"team",[],false,vis,oldEpoch))
      .toMatchObject({status:"published"});
    expect(await writeTimelineCache(db(),seed.teamId,"external",[],false,externalVis,oldEpoch))
      .toMatchObject({status:"published"});
    expect(await writeArcCache(db(),seed.teamId,"g:alpha",[],"old",{authorizationEpoch:oldEpoch}))
      .toBe(true);
    expect(await writeArcCache(db(),seed.teamId,"g:beta",[],"old",{authorizationEpoch:oldEpoch}))
      .toBe(true);

    // The alias trigger establishes the barrier before the asynchronous physical purge/repair.
    await db().from("member_emails").insert({
      team_id:seed.teamId,member_id:seed.memberId,email:`epoch-${randomUUID()}@test.local`,
    });
    expect(await readTimelineCache(db(),seed.teamId,"team",vis)).toBeNull();
    expect(await readTimelineCache(db(),seed.teamId,"external",externalVis)).toBeNull();
    expect(await readArcCache(db(),seed.teamId,"g:alpha")).toBeNull();
    expect(await readArcCache(db(),seed.teamId,"g:beta")).toBeNull();
    expect(await writeTimelineCache(db(),seed.teamId,"team",[],false,vis,oldEpoch))
      .toMatchObject({status:"cache_failed"});

    await expect(repairAttributionNow(
      failingDelete("work_timeline_cache","injected purge outage"),seed.teamId,seed.teamSlug,
      {maxBatches:10,batchSize:20},
    )).rejects.toThrow(/injected purge outage/);
    expect((await db().from("team_identity_authority").select("repair_status,last_error")
      .eq("team_id",seed.teamId).single()).data).toMatchObject({
        repair_status:"retry",last_error:expect.stringContaining("injected purge outage"),
      });
    // A new client/process view still rejects the old payload while physical cleanup is retrying.
    expect(await readTimelineCache(db(),seed.teamId,"team",vis)).toBeNull();

    await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:10,batchSize:20});
    const aliasEpoch=await authorizationEpoch(db(),seed.teamId);
    expect(aliasEpoch).toBeGreaterThan(oldEpoch);
    // This models a build that began before the alias mutation and was released after repair.
    expect(await writeTimelineCache(db(),seed.teamId,"team",[],false,vis,oldEpoch))
      .toMatchObject({status:"epoch_rejected",currentAuthorizationEpoch:aliasEpoch});
    expect(await writeArcCache(db(),seed.teamId,"g:alpha",[],"stale",{authorizationEpoch:oldEpoch}))
      .toBe(false);

    expect(await writeTimelineCache(db(),seed.teamId,"team",[],false,vis,aliasEpoch))
      .toMatchObject({status:"published"});
    const inactive=await member(seed,"Cache Inactive");
    await db().from("members").update({status:"disabled"}).eq("id",inactive);
    expect(await readTimelineCache(db(),seed.teamId,"team",vis)).toBeNull();
    await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:10,batchSize:20});
    expect(await authorizationEpoch(db(),seed.teamId)).toBeGreaterThan(aliasEpoch);
  });
});
