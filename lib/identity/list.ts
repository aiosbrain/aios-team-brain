import "server-only";
import type { DbClient } from "@/lib/db/types";
import { withIdentityMutationBoundary } from "@/lib/identity/authority";

/**
 * Read the per-member identity view for the Admin → Members "Identities" panel: each member's git
 * email aliases (`member_emails`) and provider identities (`member_identities`: slack/linear/plane/…)
 * keyed by member id. The roster email + GitHub login live on `members` (the page already has them),
 * so this returns only the additional links. Read-only — writes go through `setMemberIdentity` /
 * `removeMemberIdentity` (provider ids) and `addAuthorAlias` / `removeAuthorAlias` (emails).
 *
 * Each provider identity is returned with its mapping revision, and the two are ONE observation of
 * the link (see the read below): the Admin row hands the pair back when it changes or unlinks it.
 */

export interface MemberProviderIdentity {
  provider: string;
  externalId: string;
  handle: string;
  email: string;
  revision: number;
}

export interface MemberIdentityRecord {
  emails: string[]; // git/email aliases (member_emails)
  providers: MemberProviderIdentity[];
}

export async function listMemberIdentities(
  db: DbClient,
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

  const { data: emails, error: emailsError } = await db
    .from("member_emails")
    .select("member_id, email")
    .eq("team_id", teamId);
  if (emailsError) throw new Error(`member email aliases read failed: ${emailsError.message}`);
  for (const e of (emails ?? []) as { member_id: string; email: string }[]) {
    if (e.email) rec(e.member_id).emails.push(e.email);
  }

  // WHO holds each provider id and that id's mapping REVISION live in two tables, and the Admin row
  // sends the pair back as its observation of the link. Read apart, a remap committing between the
  // two reads pairs one member with another member's revision. So both are read inside the team's
  // identity mutation boundary, on its transaction: no identity writer can commit while it is held,
  // and the pair is one observation. The boundary ends here, before anything is rendered or shown.
  const { identities, states } = await withIdentityMutationBoundary(teamId, async () => {
    const { data: identities, error: identitiesError } = await db.from("member_identities")
      .select("member_id, provider, external_id, handle, email")
      .eq("team_id", teamId);
    if (identitiesError) throw new Error(`member identities read failed: ${identitiesError.message}`);
    const { data: states, error: statesError } = await db.from("member_identity_mapping_state")
      .select("provider, external_id, revision")
      .eq("team_id", teamId);
    if (statesError) throw new Error(`identity mapping state read failed: ${statesError.message}`);
    return { identities, states };
  });
  const revisions = new Map((states ?? []).map((state) => [
    `${String(state.provider).toLowerCase()}:${String(state.external_id)}`,
    Number(state.revision),
  ]));
  for (const i of (identities ?? []) as {
    member_id: string;
    provider: string;
    external_id: string;
    handle: string | null;
    email: string | null;
  }[]) {
    rec(i.member_id).providers.push({
      provider: i.provider,
      externalId: i.external_id,
      handle: i.handle ?? "",
      email: i.email ?? "",
      revision: revisions.get(`${i.provider.toLowerCase()}:${i.external_id}`) ?? 0,
    });
  }

  for (const r of out.values()) {
    r.emails.sort();
    r.providers.sort((a, b) => a.provider.localeCompare(b.provider) || a.externalId.localeCompare(b.externalId));
  }
  return out;
}
