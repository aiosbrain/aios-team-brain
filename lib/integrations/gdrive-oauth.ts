import "server-only";

import { adminClient } from "@/lib/db/admin";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { lockIdentityMutationAuthorities } from "@/lib/identity/authority";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { resolveConfirmedEmail } from "@/lib/identity/provider-sync";
import { lockActiveTeamAdmin, lockGdriveConnection } from "@/lib/integrations/gdrive-authority";
import { reserveGdriveIntegration, setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { decryptSecret } from "@/lib/secrets/crypto";

export class IncompleteGoogleOAuthPairError extends Error {}
export class InvalidGoogleOAuthInitiatorError extends Error {}
export class GoogleIdentityConflictError extends Error {}

/** Deterministic concurrency seam for real-Postgres lock-order regressions. */
export interface GoogleDriveOAuthPublicationHooks {
  /** Every lock the publication takes up front is held; nothing has been published yet. */
  afterLocks?: () => Promise<void>;
}

/**
 * Atomically publish a verified Google account plus its complete refresh credential.
 *
 * ONE transaction holds the integration/config, the complete encrypted credential, both verified
 * identity mappings, their revision obligations and the audits: a mapping conflict, a lost Admin
 * authorization or an incomplete credential rolls all of it back, a reservation included.
 *
 * Its locks are taken in the Drive connection order (`lockedAuthority` in gdrive-authority):
 *
 *   team identity authority → named integration advisory → integration + connection-authority rows
 *     → the initiating member
 *
 * The identity authority is FIRST, not where the mappings are finally written. A roster writer holds
 * it before a member row — and a hard deletion's foreign-key actions then reach the integration —
 * so a publication that locked its Admin and its connection and only then asked for the authority
 * would hold the rows that writer needs while waiting for the lock that writer holds. The identity
 * map is read under the held authority, and the nested `setMemberIdentity` calls re-enter it.
 *
 * Nonce consumption and the Google code exchange happen before this is called and are not part of
 * it. Nothing here is retried: not the transaction, not an unknown commit, not the code.
 */
export async function publishGoogleDriveOAuthCredential(
  input: {
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
  },
  hooks: GoogleDriveOAuthPublicationHooks = {},
): Promise<void> {
  const db = adminClient();
  const auth = { teamId: input.teamId, memberId: input.memberId };
  const subject = input.subject.startsWith("subject:") ? input.subject : `subject:${input.subject}`;
  /** The published config over whatever the connection already holds (nothing, when it is new). */
  const publishedConfig = (prior: Record<string, unknown>) => ({
    fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false,
    selectionState: "absent" as const, access: "team" as const,
    ...prior,
    // This publisher is entered only after a verified OAuth exchange. A previous local
    // service-account mode must not survive and bypass the broker on the next execution.
    authMode: "oauth" as const,
    authenticatedAccount: input.email.toLowerCase(),
    authenticatedAccountId: subject,
    ...(input.scopes ? { scopeSet: input.scopes } : {}),
  });

  await withTransaction(async () => {
    await lockIdentityMutationAuthorities([input.teamId]);
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${input.teamId}:gdrive:${input.integrationName}`,
    ]);

    // The connection, before the member. An absent one is reserved first — with no `created_by`, so
    // the reservation takes no member lock — and the reservation is this transaction's alone.
    const { rows: named } = await runSql<{ id: string }>(
      `select id from integrations where team_id=$1 and type='gdrive' and name=$2`,
      [input.teamId, input.integrationName],
    );
    const target = named[0]
      ? { id: named[0].id, reserved: false }
      : await reserveGdriveIntegration(db, input.teamId, input.integrationName, publishedConfig({}));
    const connection = await lockGdriveConnection(input.teamId, target.id);

    if (!await lockActiveTeamAdmin(input.teamId, input.memberId)) {
      throw new InvalidGoogleOAuthInitiatorError("oauth initiator is no longer an active team Admin");
    }
    await hooks.afterLocks?.();

    // A shared Google login is transport authority, not evidence that the initiating Admin is the
    // human author. Auto-link only a complete, exact roster/alias email match; unresolved accounts
    // remain visible on the integration for an audited manual mapping and never erase old credit.
    const verifiedMemberId = resolveConfirmedEmail(
      await buildIdentityMap(db, input.teamId, { strict: true }), input.email,
    );

    // Reusable config and credential are read from the LOCKED row. A connection this transaction
    // has just reserved has neither.
    const priorConfig = target.reserved ? {} : connection.config;
    const priorSecret = target.reserved || !connection.secretCiphertext
      ? null
      : decryptSecret(connection.secretCiphertext);
    let old: Record<string, unknown> = {};
    try { old = priorSecret ? JSON.parse(priorSecret) as Record<string, unknown> : {}; } catch { old = {}; }
    const mayReuse = old.account_subject === subject && old.client_id === input.clientId
      && typeof old.refresh_token === "string" && Boolean(old.refresh_token);
    const refreshToken = input.refreshToken || (mayReuse ? String(old.refresh_token) : "");
    if (!refreshToken) throw new IncompleteGoogleOAuthPairError("incomplete_oauth_pair");

    const config = publishedConfig(priorConfig);
    const secret = JSON.stringify({
      client_id: input.clientId, client_secret: input.clientSecret,
      refresh_token: refreshToken, token_uri: "https://oauth2.googleapis.com/token",
      scopes: config.scopeSet, account_subject: subject,
    });
    const { id } = await upsertIntegration(db, auth, {
      type: "gdrive", name: input.integrationName, config, status: "enabled",
    });
    await setIntegrationSecret(db, auth, id, secret);
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
