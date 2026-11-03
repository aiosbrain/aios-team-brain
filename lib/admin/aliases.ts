import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { ActorContext } from "./members";
import { runSql } from "@/lib/db/pg/pool";
import { withIdentityMutationBoundary } from "@/lib/identity/authority";
import { advanceIdentityMappingState } from "@/lib/identity/member-identities";

export interface AliasResult {
  aliased: boolean;
  backfilled: number;
  remapped: number;
  collisions: number;
  note?: string;
}

/** Complete-read, transactionally serialized alias writer. The alias and every contribution row are
 * read before mutation; any read/write failure rolls the whole change back and leaves repair pending. */
export async function addAuthorAlias(
  admin: DbClient,
  teamId: string,
  memberId: string,
  gitIdentity: string,
  opts: { force?: boolean; actor?: ActorContext } = {},
): Promise<AliasResult> {
  const email = gitIdentity.trim().toLowerCase();
  if (!email) throw new Error("email is required");
  return withIdentityMutationBoundary(teamId, async () => {
    const { rows: members } = await runSql<{ id: string; status: string; is_connector: boolean }>(
      `select id,status,is_connector from members where team_id=$1 and id=$2 for share`,
      [teamId,memberId],
    );
    if (!members[0]) throw new Error("alias target is not a member of this team");
    if (members[0].status === "disabled") throw new Error("alias target is deactivated");

    const existingRead = await admin.from("member_emails")
      .select("id, member_id").eq("team_id",teamId).eq("email",email).maybeSingle();
    if (existingRead.error) throw new Error(`alias read failed: ${existingRead.error.message}`);
    const contributionsRead = await admin.from("code_contributions")
      .select("id, member_id").eq("team_id",teamId).eq("author_key",email);
    if (contributionsRead.error) {
      throw new Error(`alias contribution read failed: ${contributionsRead.error.message}`);
    }
    const ex = existingRead.data as { id: string; member_id: string } | null;
    const res: AliasResult = { aliased:false,backfilled:0,remapped:0,collisions:0 };
    const nullIds: string[]=[];
    const otherIds: string[]=[];
    for (const row of (contributionsRead.data ?? []) as { id:string; member_id:string|null }[]) {
      if (row.member_id == null) nullIds.push(row.id);
      else if (row.member_id !== memberId) otherIds.push(row.id);
    }
    if (ex && ex.member_id !== memberId && !opts.force) {
      res.collisions=1;
      res.note=`alias ${email} already maps to a different member; pass force to remap`;
      return res;
    }

    let mappingChanged=false;
    if (!ex) {
      const write = await admin.from("member_emails").insert({ team_id:teamId,member_id:memberId,email });
      if (write.error) throw new Error(`alias insert failed: ${write.error.message}`);
      mappingChanged=true;
    } else if (ex.member_id !== memberId) {
      const write = await admin.from("member_emails").update({ member_id:memberId }).eq("id",ex.id);
      if (write.error) throw new Error(`alias remap failed: ${write.error.message}`);
      mappingChanged=true;
    }
    res.aliased=true;
    for (const id of nullIds) {
      const write = await admin.from("code_contributions").update({ member_id:memberId }).eq("id",id);
      if (write.error) throw new Error(`alias contribution backfill failed: ${write.error.message}`);
    }
    res.backfilled=nullIds.length;
    if (otherIds.length) {
      if (opts.force) {
        for (const id of otherIds) {
          const write = await admin.from("code_contributions").update({ member_id:memberId }).eq("id",id);
          if (write.error) throw new Error(`alias contribution remap failed: ${write.error.message}`);
        }
        res.remapped=otherIds.length;
      } else {
        res.collisions=otherIds.length;
        res.note=`${otherIds.length} contribution row(s) already map to another member; pass force to remap`;
      }
    }
    if (mappingChanged) {
      await advanceIdentityMappingState({
        teamId,provider:"email-alias",externalId:email,memberId,state:"linked",
      });
    }
    await audit(admin, {
      team_id:teamId,actor_kind:opts.actor?.kind ?? "system",member_id:opts.actor?.memberId ?? null,
      action:"alias.added",target_type:"member",target_id:memberId,
      meta:{ email,backfilled:res.backfilled,remapped:res.remapped,collisions:res.collisions },
    });
    return res;
  });
}

/** Successful unlink records a durable tombstone. Shared repair can therefore clear unlocked stale
 * credit without treating an ordinary never-resolved author as an unlink. */
export async function removeAuthorAlias(
  admin: DbClient,
  teamId: string,
  email: string,
  opts: { actor?: ActorContext } = {},
): Promise<{ removed:boolean }> {
  const e=email.trim().toLowerCase();
  if (!e) throw new Error("email is required");
  return withIdentityMutationBoundary(teamId, async () => {
    const read=await admin.from("member_emails")
      .select("id, member_id").eq("team_id",teamId).eq("email",e).maybeSingle();
    if (read.error) throw new Error(`alias read failed: ${read.error.message}`);
    const ex=read.data as { id:string;member_id:string }|null;
    if (!ex) return { removed:false };
    const contributions=await admin.from("code_contributions")
      .select("id, member_id").eq("team_id",teamId).eq("author_key",e);
    if (contributions.error) {
      throw new Error(`alias contribution read failed: ${contributions.error.message}`);
    }
    const creditedIds=((contributions.data ?? []) as {id:string;member_id:string|null}[])
      .filter((row)=>row.member_id===ex.member_id)
      .map((row)=>row.id);
    const write=await admin.from("member_emails").delete().eq("id",ex.id);
    if (write.error) throw new Error(`alias delete failed: ${write.error.message}`);
    for (const id of creditedIds) {
      const cleared=await admin.from("code_contributions").update({member_id:null}).eq("id",id);
      if (cleared.error) throw new Error(`alias contribution unlink failed: ${cleared.error.message}`);
    }
    await advanceIdentityMappingState({
      teamId,provider:"email-alias",externalId:e,memberId:null,state:"unlinked",
    });
    await audit(admin, {
      team_id:teamId,actor_kind:opts.actor?.kind ?? "system",member_id:opts.actor?.memberId ?? null,
      action:"alias.removed",target_type:"member",target_id:ex.member_id,
      meta:{email:e,contributions_cleared:creditedIds.length},
    });
    return { removed:true };
  });
}
