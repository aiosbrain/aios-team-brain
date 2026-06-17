import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";
import type { ActorContext } from "./members";

/**
 * Map a git author identity (email or the GitHub noreply form) to a member, and
 * backfill existing contributions. Collision-safe: an alias already pointing at a
 * DIFFERENT member, or contribution rows already mapped to a different member, are
 * reported and only re-pointed when `force` is set — never silently. team-scoped
 * `unique(team_id,email)` guarantees an alias maps to at most one member.
 */
export interface AliasResult {
  aliased: boolean; // alias row now points at this member
  backfilled: number; // previously-unmapped contribution rows updated
  remapped: number; // already-mapped-to-another-member rows changed (force only)
  collisions: number; // rows/alias that would change member and were left as-is (no force)
  note?: string;
}

export async function addAuthorAlias(
  admin: SupabaseClient,
  teamId: string,
  memberId: string,
  gitIdentity: string,
  opts: { force?: boolean; actor?: ActorContext } = {}
): Promise<AliasResult> {
  const email = gitIdentity.trim().toLowerCase();
  const res: AliasResult = { aliased: false, backfilled: 0, remapped: 0, collisions: 0 };

  // 1. alias row (team-scoped unique). Detect an existing alias on another member.
  const { data: existing } = await admin
    .from("member_emails")
    .select("id, member_id")
    .eq("team_id", teamId)
    .eq("email", email)
    .maybeSingle();
  const ex = existing as { id: string; member_id: string } | null;
  if (!ex) {
    const { error } = await admin
      .from("member_emails")
      .insert({ team_id: teamId, member_id: memberId, email });
    if (error) throw new Error(`alias insert failed: ${error.message}`);
    res.aliased = true;
  } else if (ex.member_id !== memberId) {
    if (!opts.force) {
      res.collisions++;
      res.note = `alias ${email} already maps to a different member; pass force to remap`;
      return res;
    }
    await admin.from("member_emails").update({ member_id: memberId }).eq("id", ex.id);
    res.aliased = true;
  } else {
    res.aliased = true; // already correct
  }

  // 2. backfill code_contributions for this identity (match the grouping key).
  const { data: rows } = await admin
    .from("code_contributions")
    .select("id, member_id")
    .eq("team_id", teamId)
    .eq("author_key", email);
  const nullIds: string[] = [];
  const otherIds: string[] = [];
  for (const r of (rows ?? []) as { id: string; member_id: string | null }[]) {
    if (r.member_id == null) nullIds.push(r.id);
    else if (r.member_id !== memberId) otherIds.push(r.id);
  }
  for (const id of nullIds) {
    await admin.from("code_contributions").update({ member_id: memberId }).eq("id", id);
  }
  res.backfilled = nullIds.length;
  if (otherIds.length) {
    if (opts.force) {
      for (const id of otherIds) {
        await admin.from("code_contributions").update({ member_id: memberId }).eq("id", id);
      }
      res.remapped = otherIds.length;
    } else {
      res.collisions += otherIds.length;
      res.note = `${otherIds.length} contribution row(s) already map to another member; pass force to remap`;
    }
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "alias.added",
    target_type: "member",
    target_id: memberId,
    meta: { email, backfilled: res.backfilled, remapped: res.remapped, collisions: res.collisions },
  });
  return res;
}
