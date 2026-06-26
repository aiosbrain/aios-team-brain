import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read the per-member identity view for the Admin → Members "Identities" panel: each member's git
 * email aliases (`member_emails`) and provider identities (`member_identities`: slack/linear/plane/…)
 * keyed by member id. The roster email + GitHub login live on `members` (the page already has them),
 * so this returns only the additional links. Read-only — writes go through `setMemberIdentity` /
 * `removeMemberIdentity` (provider ids) and `addAuthorAlias` / `removeAuthorAlias` (emails).
 */

export interface MemberProviderIdentity {
  provider: string;
  externalId: string;
  handle: string;
}

export interface MemberIdentityRecord {
  emails: string[]; // git/email aliases (member_emails)
  providers: MemberProviderIdentity[];
}

export async function listMemberIdentities(
  supabase: SupabaseClient,
  teamId: string
): Promise<Map<string, MemberIdentityRecord>> {
  const out = new Map<string, MemberIdentityRecord>();
  const rec = (memberId: string): MemberIdentityRecord => {
    let r = out.get(memberId);
    if (!r) {
      r = { emails: [], providers: [] };
      out.set(memberId, r);
    }
    return r;
  };

  const { data: emails } = await supabase
    .from("member_emails")
    .select("member_id, email")
    .eq("team_id", teamId);
  for (const e of (emails ?? []) as { member_id: string; email: string }[]) {
    if (e.email) rec(e.member_id).emails.push(e.email);
  }

  const { data: identities } = await supabase
    .from("member_identities")
    .select("member_id, provider, external_id, handle")
    .eq("team_id", teamId);
  for (const i of (identities ?? []) as {
    member_id: string;
    provider: string;
    external_id: string;
    handle: string | null;
  }[]) {
    rec(i.member_id).providers.push({
      provider: i.provider,
      externalId: i.external_id,
      handle: i.handle ?? "",
    });
  }

  for (const r of out.values()) r.emails.sort();
  return out;
}
