import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Read the per-member identity view for the Admin → Members "Identities" panel: each member's git
 * email aliases (`member_emails`) and provider identities (`member_identities`: slack/linear/plane/…)
 * keyed by member id. The roster email + GitHub login live on `members` (the page already has them),
 * so this returns only the additional links. Read-only — writes go through `setMemberIdentity` /
 * `removeMemberIdentity` (provider ids) and `addAuthorAlias` / `removeAuthorAlias` (emails).
 *
 * Each provider identity is returned with its mapping revision, and the two are ONE observation of
 * the link (see the statement below): the Admin row hands the pair back when it changes or unlinks it.
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

/** A provider identity as the v1 HTTP API returns it: exactly these three keys, as it always has. */
export interface ProviderIdentityResponse {
  provider: string;
  externalId: string;
  handle: string;
}

/**
 * The HTTP shape of a provider identity. `email` and `revision` are the Admin row's observation of
 * the link — what an authorized admin hands back to change or unlink it — and are not part of the
 * API: every key is named here, so a field added to the internal record never reaches a response.
 */
export function providerIdentityResponse(identity: MemberProviderIdentity): ProviderIdentityResponse {
  return { provider: identity.provider, externalId: identity.externalId, handle: identity.handle };
}

/**
 * WHO holds each provider id, and that id's mapping REVISION, read by ONE statement.
 *
 * The two live in different tables, and the Admin row sends the pair back as its observation of the
 * link. Read by two statements, a remap committing between them pairs one member with another
 * member's revision. One statement has one snapshot: the writer changes both tables in one
 * transaction, so this sees the link either wholly before a remap or wholly after it.
 *
 * It takes no lock — not the team's identity authority, not a row lock — so it never waits for a
 * writer and never makes one wait. What it returns can be stale the moment it returns; the link and
 * unlink actions re-observe holder and revision under the authority before they write, and refuse a
 * pair that is no longer the link.
 *
 *   - LEFT JOIN from the identity: a legacy identity with no mapping state is still listed (its
 *     revision reads 0), and a mapping state with no identity — an unlinked tombstone — is not.
 *   - The provider is matched case-insensitively and the external id exactly, as before.
 *   - Exactly one row per identity, whatever the mapping state holds: should two state rows match
 *     one identity (providers differing only in case), the one spelled like the identity wins, then
 *     the higher revision.
 */
const PROVIDER_IDENTITIES_SQL = `
select distinct on (i.id)
       i.member_id, i.provider, i.external_id, i.handle, i.email, s.revision
  from member_identities i
  left join member_identity_mapping_state s
    on s.team_id = i.team_id
   and lower(s.provider) = lower(i.provider)
   and s.external_id = i.external_id
 where i.team_id = $1
 order by i.id, (s.provider = i.provider) desc nulls last, s.revision desc nulls last`;

interface ProviderIdentityRow {
  member_id: string;
  provider: string;
  external_id: string;
  handle: string | null;
  email: string | null;
  revision: string | number | null;
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

  let identities: ProviderIdentityRow[];
  try {
    identities = (await runSql<ProviderIdentityRow>(PROVIDER_IDENTITIES_SQL, [teamId])).rows;
  } catch (error) {
    throw new Error(`member identities read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const i of identities) {
    // No mapping state at all is revision 0 — the reading the writer itself makes. A state row
    // whose revision is not a positive integer is not a revision: it is a failed read.
    const revision = i.revision === null ? 0 : Number(i.revision);
    if (!Number.isSafeInteger(revision) || revision < 0 || (i.revision !== null && revision === 0)) {
      throw new Error(`identity mapping state read failed: malformed revision for ${i.provider} identity ${i.external_id}`);
    }
    rec(i.member_id).providers.push({
      provider: i.provider,
      externalId: i.external_id,
      handle: i.handle ?? "",
      email: i.email ?? "",
      revision,
    });
  }

  for (const r of out.values()) {
    r.emails.sort();
    r.providers.sort((a, b) => a.provider.localeCompare(b.provider) || a.externalId.localeCompare(b.externalId));
  }
  return out;
}
