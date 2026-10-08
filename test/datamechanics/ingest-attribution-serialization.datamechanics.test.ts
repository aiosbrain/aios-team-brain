import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ItemPayload } from "@/lib/api/schemas";
import { ingestApiItem, ingestItem } from "@/lib/ingest";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { repairAttributionItem } from "@/lib/ingest/reattribute";
import { buildIdentityAuthoritySnapshot } from "@/lib/identity/authority";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { createMember, deleteMember, rollbackMemberCreation } from "@/lib/admin/members";
import { activateInvitedMembership, ensureAuthUser, linkMemberByEmail } from "@/lib/auth/pg-login";
import { convergeIdentityAttribution, db, seedTeam, type Seed } from "./helpers";

const sha=(body:string)=>createHash("sha256").update(body).digest("hex");

async function addMember(seed:Seed,name:string,email=`${randomUUID()}@test.local`):Promise<string>{
  const {data,error}=await db().from("members").insert({
    team_id:seed.teamId,email,display_name:name,actor_handle:`actor-${randomUUID().slice(0,8)}`,
    role:"member",tier:"team",status:"active",is_connector:false,
  }).select("id").single();
  if(error||!data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as {id:string}).id;
}

function payload(sourceId:string,body:string,path=`gdrive/${sourceId}.md`):ItemPayload{
  return {
    project:"drive-serialization",path,kind:"artifact",access:"team",actor:"gdrive-sync",
    body,content_sha256:sha(body),frontmatter:{
      source:"gdrive",source_id:sourceId,title:`Doc ${sourceId}`,
      authors:[{provider:"gdrive",external_id:`permission:${sourceId}`,role:"editor"}],
      contributions:[{external_id:`permission:${sourceId}`,role:"editor",at:"2026-09-21T12:00:00Z"}],
    },
  } as ItemPayload;
}

async function state(itemId:string){
  const item=(await db().from("items").select("member_id,member_id_locked,body")
    .eq("id",itemId).single()).data as {member_id:string|null;member_id_locked:boolean;body:string};
  const versions=((await db().from("item_versions").select("member_id,body")
    .eq("item_id",itemId)).data ?? []) as {member_id:string|null;body:string}[];
  const evidence=((await db().from("gdrive_contribution_evidence")
    .select("member_id,diagnostic").eq("item_id",itemId)).data ?? []) as {
      member_id:string|null;diagnostic:string|null;
    }[];
  return {item,versions,evidence};
}

async function expectRepairPending(teamId:string){
  const authority=(await db().from("team_identity_authority")
    .select("repair_status, revision, repair_revision").eq("team_id",teamId).single()).data as {
      repair_status:string;revision:number;repair_revision:number;
    };
  expect(authority.repair_status).toBe("pending");
  expect(Number(authority.repair_revision)).toBe(Number(authority.revision));
}

async function correct(seed:Seed,itemId:string,toMember:string,hooks:Parameters<typeof applyAttributionCorrection>[5]={}){
  const result=await applyAttributionCorrection(db(),seed.teamId,{
    kind:"reassign",match:{itemId},toMember,
  },{memberId:seed.memberId},1,hooks);
  expect(result).toMatchObject({ok:true,updated:1});
}

describe("common ingest attribution serialization (real Postgres)",()=>{
  it("applies the same correction serialization to the authenticated API ingest owner",async()=>{
    const seed=await seedTeam();
    const auth={
      teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID(),memberTier:"team" as const,
      memberRole:"admin" as const,actorHandle:"api-test",displayName:"Tester",email:null,isConnector:false,
    };
    const sourceId=`api-${randomUUID()}`;
    const firstPayload={...payload(sourceId,"api first"),frontmatter:{source:"github",title:"API"}};
    const first=await ingestApiItem(db(),auth,firstPayload,"team",{authorMemberId:seed.memberId},"team");
    let release!:()=>void;
    let paused!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{paused=resolve;});
    const changed={...firstPayload,body:"api changed",content_sha256:sha("api changed")};
    const worker=ingestApiItem(db(),auth,changed,"team",{authorMemberId:seed.memberId},"team",undefined,{
      beforeAttributionLock:async()=>{paused();await gate;},
    });
    await ready;
    await correct(seed,first.id,"nobody");
    release();
    await expect(worker).resolves.toMatchObject({status:"updated"});
    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:null,member_id_locked:true,body:"api changed"});
    expect(stored.versions.every((row)=>row.member_id===null)).toBe(true);
  });

  it.each([
    {label:"changed credit-nobody",changed:true,named:false},
    {label:"unchanged credit-nobody",changed:false,named:false},
    {label:"changed named correction",changed:true,named:true},
    {label:"unchanged named correction",changed:false,named:true},
  ])("rereads and preserves a correction committed before its authoritative read: $label",async({changed,named})=>{
    const seed=await seedTeam();
    const namedId=named ? await addMember(seed,"Named Correction") : null;
    const sourceId=`serialized-${randomUUID()}`;
    const firstPayload=payload(sourceId,"first body");
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const first=await ingestItem(db(),auth,firstPayload,"team",{authorMemberId:seed.memberId});

    let release!:()=>void;
    let paused!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{paused=resolve;});
    const next=changed ? payload(sourceId,"changed body",firstPayload.path) : firstPayload;
    const worker=ingestItem(db(),auth,next,"team",{authorMemberId:seed.memberId},"team",undefined,{
      concurrencyHooks:{beforeAttributionLock:async()=>{paused();await gate;}},
    });
    await ready;
    await correct(seed,first.id,named ? "Named Correction" : "nobody");
    release();
    await expect(worker).resolves.toMatchObject({status:changed ? "updated" : "unchanged"});

    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:namedId,member_id_locked:true});
    expect(stored.versions.length).toBe(changed ? 2 : 1);
    expect(stored.versions.every((row)=>row.member_id===namedId)).toBe(true);
    expect(stored.evidence.length).toBeGreaterThan(0);
    expect(stored.evidence.every((row)=>row.member_id===namedId)).toBe(true);
    expect(stored.evidence.every((row)=>row.diagnostic===(named ? "manual_attribution" : "manual_credit_nobody"))).toBe(true);
  });

  it("makes a reverse-order correction wait for ingest, then lets the correction win every ledger",async()=>{
    const seed=await seedTeam();
    const sourceId=`reverse-${randomUUID()}`;
    const firstPayload=payload(sourceId,"first body");
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const first=await ingestItem(db(),auth,firstPayload,"team",{authorMemberId:seed.memberId});

    let release!:()=>void;
    let locked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{locked=resolve;});
    const worker=ingestItem(db(),auth,payload(sourceId,"second body",firstPayload.path),"team",
      {authorMemberId:seed.memberId},"team",undefined,{
        concurrencyHooks:{afterAttributionRead:async()=>{locked();await gate;}},
      });
    await ready;
    let correctionAttempted!:()=>void;
    let correctionLocked=false;
    const attempted=new Promise<void>((resolve)=>{correctionAttempted=resolve;});
    const correction=correct(seed,first.id,"nobody",{
      beforeItemLock:async()=>{correctionAttempted();},
      afterItemLock:async()=>{correctionLocked=true;},
    });
    await attempted;
    expect(correctionLocked).toBe(false);
    release();
    await expect(worker).resolves.toMatchObject({status:"updated"});
    await correction;

    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:null,member_id_locked:true,body:"second body"});
    expect(stored.versions.every((row)=>row.member_id===null)).toBe(true);
    expect(stored.evidence.every((row)=>row.member_id===null&&row.diagnostic==="manual_credit_nobody")).toBe(true);
  });

  it("lets changed ingest finish its target-member version before a waiting named correction",async()=>{
    const seed=await seedTeam();
    const target=await addMember(seed,"Named Wait Target");
    const sourceId=`named-wait-${randomUUID()}`;
    const firstPayload=payload(sourceId,"first body");
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const first=await ingestItem(db(),auth,firstPayload,"team",{authorMemberId:target});

    let releaseIngest!:()=>void;
    let ingestLocked!:()=>void;
    const ingestGate=new Promise<void>((resolve)=>{releaseIngest=resolve;});
    const ingestReady=new Promise<void>((resolve)=>{ingestLocked=resolve;});
    const ingest=ingestItem(db(),auth,payload(sourceId,"changed while named waits",firstPayload.path),
      "team",{authorMemberId:target},"team",undefined,{
        concurrencyHooks:{afterAttributionRead:async()=>{ingestLocked();await ingestGate;}},
      });
    await ingestReady;
    let correctionAttempted!:()=>void;
    let correctionLocked=false;
    const attempted=new Promise<void>((resolve)=>{correctionAttempted=resolve;});
    const correction=correct(seed,first.id,"Named Wait Target",{
      beforeItemLock:async()=>{correctionAttempted();},
      afterItemLock:async()=>{correctionLocked=true;},
    });
    await attempted;
    expect(correctionLocked).toBe(false);
    releaseIngest();
    await expect(ingest).resolves.toMatchObject({status:"updated"});
    await correction;

    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:target,member_id_locked:true});
    expect(stored.versions).toHaveLength(2);
    expect(stored.versions.every((row)=>row.member_id===target)).toBe(true);
  });

  it("holds a named correction first, then a changed ingest rereads and preserves it",async()=>{
    const seed=await seedTeam();
    const target=await addMember(seed,"Named First Target");
    const sourceId=`named-first-${randomUUID()}`;
    const firstPayload=payload(sourceId,"first body");
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const first=await ingestItem(db(),auth,firstPayload,"team",{authorMemberId:seed.memberId});

    let releaseCorrection!:()=>void;
    let correctionLocked!:()=>void;
    const correctionGate=new Promise<void>((resolve)=>{releaseCorrection=resolve;});
    const correctionReady=new Promise<void>((resolve)=>{correctionLocked=resolve;});
    const correction=correct(seed,first.id,"Named First Target",{
      afterItemLock:async()=>{correctionLocked();await correctionGate;},
    });
    await correctionReady;
    let ingestAttempted!:()=>void;
    const attempted=new Promise<void>((resolve)=>{ingestAttempted=resolve;});
    const ingest=ingestItem(db(),auth,payload(sourceId,"changed after named lock",firstPayload.path),
      "team",{authorMemberId:seed.memberId},"team",undefined,{
        concurrencyHooks:{beforeAttributionLock:async()=>{ingestAttempted();}},
      });
    await attempted;
    releaseCorrection();
    await correction;
    await expect(ingest).resolves.toMatchObject({status:"updated"});

    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:target,member_id_locked:true});
    expect(stored.versions.every((row)=>row.member_id===target)).toBe(true);
  });

  it("serializes a multi-item named correction without blocking an owned-item version FK",async()=>{
    const seed=await seedTeam();
    const target=await addMember(seed,"Multi Target");
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const aPayload=payload(`multi-a-${randomUUID()}`,"multi a");
    const bPayload=payload(`multi-b-${randomUUID()}`,"multi b");
    const a=await ingestItem(db(),auth,aPayload,"team",{authorMemberId:target});
    const b=await ingestItem(db(),auth,bPayload,"team",{authorMemberId:target});
    const held=a.id.localeCompare(b.id)>0 ? {result:a,payload:aPayload} : {result:b,payload:bPayload};

    let releaseIngest!:()=>void;
    let ingestLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{releaseIngest=resolve;});
    const ready=new Promise<void>((resolve)=>{ingestLocked=resolve;});
    const ingest=ingestItem(db(),auth,payload(
      String(held.payload.frontmatter?.source_id),"multi changed",held.payload.path,
    ),"team",{authorMemberId:target},"team",undefined,{
      concurrencyHooks:{afterAttributionRead:async()=>{ingestLocked();await gate;}},
    });
    await ready;
    let waitingOnHeld!:()=>void;
    const waiting=new Promise<void>((resolve)=>{waitingOnHeld=resolve;});
    const correction=applyAttributionCorrection(db(),seed.teamId,{
      kind:"reassign",match:{source:"gdrive"},toMember:"Multi Target",
    },{memberId:seed.memberId},2,{
      beforeItemLock:async(id)=>{if(id===held.result.id) waitingOnHeld();},
    });
    await waiting;
    releaseIngest();
    await ingest;
    await expect(correction).resolves.toMatchObject({ok:true,updated:2});
    for(const itemId of [a.id,b.id]){
      const stored=await state(itemId);
      expect(stored.item).toMatchObject({member_id:target,member_id_locked:true});
      expect(stored.versions.every((row)=>row.member_id===target)).toBe(true);
    }
  });

  it("rejects a named correction when production deactivation wins identity authority",async()=>{
    const seed=await seedTeam();
    const email=`deactivate-${randomUUID()}@test.local`;
    await addMember(seed,"Deactivation Target",email);
    const sourceId=`deactivate-${randomUUID()}`;
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const first=await ingestItem(db(),auth,payload(sourceId,"deactivation body"),"team",{
      authorMemberId:seed.memberId,
    });

    let releaseDeactivation!:()=>void;
    let deactivationLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{releaseDeactivation=resolve;});
    const ready=new Promise<void>((resolve)=>{deactivationLocked=resolve;});
    const deactivation=deleteMember(db(),seed.teamId,email,{
      actor:{kind:"member",memberId:seed.memberId},
      concurrencyHooks:{afterIdentityLock:async()=>{deactivationLocked();await gate;}},
    });
    await ready;
    let correctionWaiting!:()=>void;
    const waiting=new Promise<void>((resolve)=>{correctionWaiting=resolve;});
    const correction=applyAttributionCorrection(db(),seed.teamId,{
      kind:"reassign",match:{itemId:first.id},toMember:"Deactivation Target",
    },{memberId:seed.memberId},1,{beforeIdentityLock:async()=>{correctionWaiting();}});
    await waiting;
    releaseDeactivation();
    await expect(deactivation).resolves.toMatchObject({deleted:true,mode:"soft"});
    await expect(correction).rejects.toThrow(/no longer an active human member/);

    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:seed.memberId,member_id_locked:false});
    expect(stored.versions.every((row)=>row.member_id===seed.memberId)).toBe(true);
  });

  it("serializes an existing-member upsert before a named correction without deadlock",async()=>{
    const seed=await seedTeam();
    const email=`upsert-first-${randomUUID()}@test.local`;
    const name=`Upsert First ${randomUUID().slice(0,8)}`;
    const target=await addMember(seed,name,email);
    const first=await ingestItem(db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},
      payload(`upsert-first-${randomUUID()}`,"upsert first"),"team",{authorMemberId:seed.memberId});

    let release!:()=>void;
    let locked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{locked=resolve;});
    const upsert=createMember(db(),seed.teamId,{
      email,displayName:name,actorHandle:`upserted-${randomUUID().slice(0,8)}`,role:"member",
    },{upsert:true,concurrencyHooks:{afterIdentityLock:async()=>{locked();await gate;}}});
    await ready;
    let correctionAttempted!:()=>void;
    const attempted=new Promise<void>((resolve)=>{correctionAttempted=resolve;});
    const correction=correct(seed,first.id,name,{beforeIdentityLock:async()=>{correctionAttempted();}});
    await attempted;
    release();
    await expect(upsert).resolves.toMatchObject({id:target});
    await correction;
    expect((await state(first.id)).item).toMatchObject({member_id:target,member_id_locked:true});
    await expectRepairPending(seed.teamId);
  });

  it("lets a named correction finish before a waiting existing-member upsert",async()=>{
    const seed=await seedTeam();
    const email=`correction-first-${randomUUID()}@test.local`;
    const name=`Correction First ${randomUUID().slice(0,8)}`;
    const target=await addMember(seed,name,email);
    const first=await ingestItem(db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},
      payload(`correction-first-${randomUUID()}`,"correction first"),"team",{authorMemberId:seed.memberId});

    let release!:()=>void;
    let correctionLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{correctionLocked=resolve;});
    const correction=correct(seed,first.id,name,{afterIdentityLock:async()=>{correctionLocked();await gate;}});
    await ready;
    let attemptedResolve!:()=>void;
    let upsertAcquired=false;
    const attempted=new Promise<void>((resolve)=>{attemptedResolve=resolve;});
    const upsert=createMember(db(),seed.teamId,{
      email,displayName:name,actorHandle:`after-${randomUUID().slice(0,8)}`,role:"member",
    },{upsert:true,concurrencyHooks:{
      beforeIdentityLock:async()=>{attemptedResolve();},
      afterIdentityLock:async()=>{upsertAcquired=true;},
    }});
    await attempted;
    expect(upsertAcquired).toBe(false);
    release();
    await correction;
    await expect(upsert).resolves.toMatchObject({id:target});
    expect((await state(first.id)).item).toMatchObject({member_id:target,member_id_locked:true});
    await expectRepairPending(seed.teamId);
  });

  it("makes a named correction fail closed when invite rollback deletes its resolved target first",async()=>{
    const seed=await seedTeam();
    const name=`Rollback First ${randomUUID().slice(0,8)}`;
    const target=await addMember(seed,name);
    const first=await ingestItem(db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},
      payload(`rollback-first-${randomUUID()}`,"rollback first"),"team",{authorMemberId:seed.memberId});
    let release!:()=>void;
    let rollbackLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{rollbackLocked=resolve;});
    const rollback=rollbackMemberCreation(db(),seed.teamId,target,{
      concurrencyHooks:{afterIdentityLock:async()=>{rollbackLocked();await gate;}},
    });
    await ready;
    let correctionAttempted!:()=>void;
    const attempted=new Promise<void>((resolve)=>{correctionAttempted=resolve;});
    const correction=applyAttributionCorrection(db(),seed.teamId,{
      kind:"reassign",match:{itemId:first.id},toMember:name,
    },{memberId:seed.memberId},1,{beforeIdentityLock:async()=>{correctionAttempted();}});
    await attempted;
    release();
    await rollback;
    await expect(correction).rejects.toThrow(/no longer an active human member/);
    expect((await state(first.id)).item).toMatchObject({member_id:seed.memberId,member_id_locked:false});
    await expectRepairPending(seed.teamId);
  });

  it("lets invite rollback wait for a named correction, then clears the deleted target safely",async()=>{
    const seed=await seedTeam();
    const name=`Rollback After ${randomUUID().slice(0,8)}`;
    const target=await addMember(seed,name);
    const first=await ingestItem(db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},
      payload(`rollback-after-${randomUUID()}`,"rollback after"),"team",{authorMemberId:seed.memberId});
    let release!:()=>void;
    let correctionLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{correctionLocked=resolve;});
    const correction=correct(seed,first.id,name,{afterIdentityLock:async()=>{correctionLocked();await gate;}});
    await ready;
    let attemptedResolve!:()=>void;
    let rollbackAcquired=false;
    const attempted=new Promise<void>((resolve)=>{attemptedResolve=resolve;});
    const rollback=rollbackMemberCreation(db(),seed.teamId,target,{concurrencyHooks:{
      beforeIdentityLock:async()=>{attemptedResolve();},afterIdentityLock:async()=>{rollbackAcquired=true;},
    }});
    await attempted;
    expect(rollbackAcquired).toBe(false);
    release();
    await correction;
    await rollback;
    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:null,member_id_locked:true});
    expect(stored.versions.every((row)=>row.member_id===null)).toBe(true);
    await expectRepairPending(seed.teamId);
  });

  it("serializes login activation before a named correction",async()=>{
    const seed=await seedTeam();
    const targetName=`Activation Target ${randomUUID().slice(0,8)}`;
    const target=await addMember(seed,targetName);
    const invitedEmail=`activation-first-${randomUUID()}@test.local`;
    const invited=await createMember(db(),seed.teamId,{
      email:invitedEmail,displayName:"Invited",actorHandle:`invited-${randomUUID().slice(0,8)}`,role:"member",
    });
    const authUserId=await ensureAuthUser(invitedEmail);
    await linkMemberByEmail(authUserId,invitedEmail);
    const first=await ingestItem(db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},
      payload(`activation-first-${randomUUID()}`,"activation first"),"team",{authorMemberId:seed.memberId});
    await convergeIdentityAttribution(seed);
    let release!:()=>void;
    let activationLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{activationLocked=resolve;});
    const activation=activateInvitedMembership(seed.teamId,authUserId,{
      concurrencyHooks:{afterIdentityLock:async()=>{activationLocked();await gate;}},
    });
    await ready;
    let correctionAttempted!:()=>void;
    const attempted=new Promise<void>((resolve)=>{correctionAttempted=resolve;});
    const correction=correct(seed,first.id,targetName,{beforeIdentityLock:async()=>{correctionAttempted();}});
    await attempted;
    release();
    await activation;
    await correction;
    expect((await db().from("members").select("status").eq("id",invited.id).single()).data)
      .toMatchObject({status:"active"});
    expect((await state(first.id)).item).toMatchObject({member_id:target,member_id_locked:true});
    await expectRepairPending(seed.teamId);
  });

  it("lets login activation wait for a named correction and preserves the correction",async()=>{
    const seed=await seedTeam();
    const targetName=`Activation After ${randomUUID().slice(0,8)}`;
    const target=await addMember(seed,targetName);
    const invitedEmail=`activation-after-${randomUUID()}@test.local`;
    const invited=await createMember(db(),seed.teamId,{
      email:invitedEmail,displayName:"Invited",actorHandle:`invited-${randomUUID().slice(0,8)}`,role:"member",
    });
    const authUserId=await ensureAuthUser(invitedEmail);
    await linkMemberByEmail(authUserId,invitedEmail);
    const first=await ingestItem(db(),{teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()},
      payload(`activation-after-${randomUUID()}`,"activation after"),"team",{authorMemberId:seed.memberId});
    await convergeIdentityAttribution(seed);
    let release!:()=>void;
    let correctionLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{correctionLocked=resolve;});
    const correction=correct(seed,first.id,targetName,{afterIdentityLock:async()=>{correctionLocked();await gate;}});
    await ready;
    let attemptedResolve!:()=>void;
    let activationAcquired=false;
    const attempted=new Promise<void>((resolve)=>{attemptedResolve=resolve;});
    const activation=activateInvitedMembership(seed.teamId,authUserId,{concurrencyHooks:{
      beforeIdentityLock:async()=>{attemptedResolve();},afterIdentityLock:async()=>{activationAcquired=true;},
    }});
    await attempted;
    expect(activationAcquired).toBe(false);
    release();
    await correction;
    await activation;
    expect((await db().from("members").select("status").eq("id",invited.id).single()).data)
      .toMatchObject({status:"active"});
    expect((await state(first.id)).item).toMatchObject({member_id:target,member_id_locked:true});
    await expectRepairPending(seed.teamId);
  });

  it("serializes a mapped Drive ingest and mapping repair on the same canonical item lock",async()=>{
    const seed=await seedTeam();
    const sourceId=`repair-${randomUUID()}`;
    const externalId=`permission:${sourceId}`;
    const mapped=await addMember(seed,"Mapped Author");
    await setMemberIdentity(db(),seed.teamId,mapped,{provider:"gdrive",externalId});
    const snapshot=await buildIdentityAuthoritySnapshot(db(),seed.teamId);
    const firstPayload=payload(sourceId,"first body");
    const auth={teamId:seed.teamId,memberId:seed.memberId,apiKeyId:randomUUID()};
    const first=await ingestItem(db(),auth,firstPayload,"team",{authorMemberId:mapped});

    let release!:()=>void;
    let ingestLocked!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{ingestLocked=resolve;});
    // Use explicit current credit here so the mapping repair can reach the canonical item lock; a
    // mappingRevision-derived ingest also holds the broader identity-authority lock and therefore
    // serializes even earlier by design.
    const ingest=ingestItem(db(),auth,payload(sourceId,"mapped update",firstPayload.path),"team",
      {authorMemberId:mapped},"team",undefined,{
        concurrencyHooks:{afterAttributionRead:async()=>{ingestLocked();await gate;}},
      });
    await ready;
    let repairAttempted!:()=>void;
    let repairLocked=false;
    const attempted=new Promise<void>((resolve)=>{repairAttempted=resolve;});
    const repair=repairAttributionItem(db(),snapshot,first.id,{
      beforeItemLock:async()=>{repairAttempted();},afterItemLock:async()=>{repairLocked=true;},
    });
    await attempted;
    expect(repairLocked).toBe(false);
    release();
    await ingest;
    await repair;

    const stored=await state(first.id);
    expect(stored.item).toMatchObject({member_id:mapped,member_id_locked:false,body:"mapped update"});
    expect(stored.versions.every((row)=>row.member_id===mapped)).toBe(true);
  },15_000);
});
