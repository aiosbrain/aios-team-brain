import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";

/**
 * Shared admin primitive: create (or upsert) a member. Used by the admin server
 * action (UI) and the admin CLI so there's one audited write path. Authorization
 * is the caller's responsibility (the action gates via requireAdmin; the CLI is a
 * service-role/system actor). Always runs on the service-role client.
 */
export interface MemberInput {
  email: string;
  displayName: string;
  actorHandle: string;
  role: "admin" | "lead" | "member";
  tier?: "team" | "external";
}

export interface ActorContext {
  kind?: "member" | "system";
  memberId?: string | null;
}

export async function createMember(
  admin: SupabaseClient,
  teamId: string,
  input: MemberInput,
  opts: { upsert?: boolean; actor?: ActorContext } = {}
): Promise<{ id: string; status: string }> {
  const email = input.email.trim().toLowerCase();
  // `status` is intentionally omitted so the column default ('invited') applies on
  // insert while an existing member's status is preserved on upsert-conflict.
  const row = {
    team_id: teamId,
    email,
    display_name: input.displayName.trim(),
    actor_handle: input.actorHandle.trim().toLowerCase(),
    role: input.role,
    tier: input.tier ?? "team",
  };

  const builder = opts.upsert
    ? admin.from("members").upsert(row, { onConflict: "team_id,email" })
    : admin.from("members").insert({ ...row, status: "invited" });

  const { data, error } = await builder.select("id, status").single();
  if (error || !data) throw new Error(`create member failed: ${error?.message}`);

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "member.created",
    target_type: "member",
    target_id: data.id,
    meta: { email, role: input.role, upsert: Boolean(opts.upsert) },
  });
  return { id: data.id, status: data.status };
}
