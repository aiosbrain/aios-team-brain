import "server-only";

import { adminClient } from "@/lib/db/admin";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { resolveConfirmedEmail } from "@/lib/identity/provider-sync";
import { getIntegrationWithSecret, setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";

export class IncompleteGoogleOAuthPairError extends Error {}
export class InvalidGoogleOAuthInitiatorError extends Error {}
export class GoogleIdentityConflictError extends Error {}

/** Atomically publish a verified Google account plus its complete refresh credential. */
export async function publishGoogleDriveOAuthCredential(input: {
  teamId: string;
  memberId: string;
  integrationName: string;
  clientId: string;
  clientSecret: string;
  subject: string;
  email: string;
  name?: string;
  refreshToken?: string;
  scopes?: string[];
}): Promise<void> {
  const db = adminClient();
  const subject = input.subject.startsWith("subject:") ? input.subject : `subject:${input.subject}`;
  await withTransaction(async () => {
    const { rows: initiators } = await runSql<{ role: string; status: string }>(
      `select role,status from members where id=$1 and team_id=$2 for update`,
      [input.memberId, input.teamId],
    );
    if (initiators[0]?.status !== "active" || initiators[0]?.role !== "admin") {
      throw new InvalidGoogleOAuthInitiatorError("oauth initiator is no longer an active team Admin");
    }
    // A shared Google login is transport authority, not evidence that the initiating Admin is the
    // human author. Auto-link only a complete, exact roster/alias email match; unresolved accounts
    // remain visible on the integration for an audited manual mapping and never erase old credit.
    const verifiedMemberId = resolveConfirmedEmail(
      await buildIdentityMap(db, input.teamId, { strict: true }), input.email,
    );
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${input.teamId}:gdrive:${input.integrationName}`,
    ]);
    const existing = await getIntegrationWithSecret(db, input.teamId, "gdrive", input.integrationName);
    let old: Record<string, unknown> = {};
    try { old = existing?.secret ? JSON.parse(existing.secret) as Record<string, unknown> : {}; } catch { old = {}; }
    const mayReuse = old.account_subject === subject && old.client_id === input.clientId
      && typeof old.refresh_token === "string" && Boolean(old.refresh_token);
    const refreshToken = input.refreshToken || (mayReuse ? String(old.refresh_token) : "");
    if (!refreshToken) throw new IncompleteGoogleOAuthPairError("incomplete_oauth_pair");

    const config = {
      fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "absent" as const, access: "team" as const,
      ...(existing?.config ?? {}),
      // This publisher is entered only after a verified OAuth exchange. A previous local
      // service-account mode must not survive and bypass the broker on the next execution.
      authMode: "oauth" as const,
      authenticatedAccount: input.email.toLowerCase(),
      authenticatedAccountId: subject,
      ...(input.scopes ? { scopeSet: input.scopes } : {}),
    };
    const secret = JSON.stringify({
      client_id: input.clientId, client_secret: input.clientSecret,
      refresh_token: refreshToken, token_uri: "https://oauth2.googleapis.com/token",
      scopes: config.scopeSet, account_subject: subject,
    });
    const { id } = await upsertIntegration(db, { teamId: input.teamId, memberId: input.memberId }, {
      type: "gdrive", name: input.integrationName, config, status: "enabled",
    });
    await setIntegrationSecret(db, { teamId: input.teamId, memberId: input.memberId }, id, secret);
    if (verifiedMemberId) {
      const subjectIdentity = await setMemberIdentity(db, input.teamId, verifiedMemberId, {
        provider: "gdrive", externalId: subject, email: input.email,
        handle: input.name ?? input.email,
      }, { actor: { kind: "member", memberId: input.memberId } });
      const emailIdentity = await setMemberIdentity(db, input.teamId, verifiedMemberId, {
        provider: "gdrive", externalId: `author-email:${input.email.toLowerCase()}`,
        email: input.email, handle: input.name ?? input.email,
      }, { actor: { kind: "member", memberId: input.memberId } });
      if (subjectIdentity.conflict || emailIdentity.conflict) {
        throw new GoogleIdentityConflictError("verified Google identity conflicts with an existing manual mapping");
      }
    }
  });
}
