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
 *
 * VERIFIED SUBJECT ≠ VERIFIED EMAIL (AIO-1167 R41, AC-08). The OAuth exchange proves the account's
 * stable subject — enough to store and broker the credential. It does not prove the email: Google
 * states that separately (`email_verified`). So the email may create identity mappings only when
 * `emailVerified` is the literal `true`. Otherwise — false, missing, or no email at all — NEITHER
 * the `subject:` nor the `author-email:` mapping is derived from that email, no mapping revision or
 * repair obligation is created, and an existing deliberate link is left exactly as it is. The
 * credential is still stored by subject, the account stays visibly unresolved, and the audited
 * manual mapping path resolves it. An unverified email is kept only as explicitly untrusted account
 * metadata on the connection (`authenticatedAccountEmailVerified: false`), never in
 * `member_identities.email`, which the shared resolver folds into its email map.
 */
export async function publishGoogleDriveOAuthCredential(
  input: {
    teamId: string;
    memberId: string;
    integrationName: string;
    clientId: string;
    clientSecret: string;
    subject: string;
    /** The account email Google returned, if any. */
    email?: string | null;
    /** Google's `email_verified` claim, carried as is: only the literal `true` is evidence. */
    emailVerified: boolean;
    name?: string;
    refreshToken?: string;
    scopes?: string[];
  },
  hooks: GoogleDriveOAuthPublicationHooks = {},
): Promise<void> {
  const db = adminClient();
  const auth = { teamId: input.teamId, memberId: input.memberId };
  const subject = input.subject.startsWith("subject:") ? input.subject : `subject:${input.subject}`;
  const accountEmail = typeof input.email === "string" && input.email.trim()
    ? input.email.trim().toLowerCase()
    : null;
  // Strict on purpose: a truthy string or a missing claim from a direct caller is not verification.
  const verifiedEmail = input.emailVerified === true ? accountEmail : null;
  /** The published config over whatever the connection already holds (nothing, when it is new). */
  const publishedConfig = (prior: Record<string, unknown>) => {
    const config: Record<string, unknown> = {
      fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "absent" as const, access: "team" as const,
      ...prior,
      // This publisher is entered only after a verified OAuth exchange. A previous local
      // service-account mode must not survive and bypass the broker on the next execution.
      authMode: "oauth" as const,
      authenticatedAccountId: subject,
      ...(input.scopes ? { scopeSet: input.scopes } : {}),
    };
    // The account's email describes THIS account only: a previous account's survives nowhere.
    delete config.authenticatedAccount;
    delete config.authenticatedAccountEmailVerified;
    if (accountEmail) {
      config.authenticatedAccount = accountEmail;
      config.authenticatedAccountEmailVerified = verifiedEmail !== null;
    }
    return config;
  };

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
    // Only a VERIFIED email is looked up at all: an unverified or missing one maps no one.
    const verifiedMemberId = verifiedEmail
      ? resolveConfirmedEmail(await buildIdentityMap(db, input.teamId, { strict: true }), verifiedEmail)
      : null;

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
    if (verifiedMemberId && verifiedEmail) {
      const subjectIdentity = await setMemberIdentity(db, input.teamId, verifiedMemberId, {
        provider: "gdrive", externalId: subject, email: verifiedEmail,
        handle: input.name ?? verifiedEmail,
      }, { actor: { kind: "member", memberId: input.memberId } });
      const emailIdentity = await setMemberIdentity(db, input.teamId, verifiedMemberId, {
        provider: "gdrive", externalId: `author-email:${verifiedEmail}`,
        email: verifiedEmail, handle: input.name ?? verifiedEmail,
      }, { actor: { kind: "member", memberId: input.memberId } });
      if (subjectIdentity.conflict || emailIdentity.conflict) {
        throw new GoogleIdentityConflictError("verified Google identity conflicts with an existing manual mapping");
      }
    }
  });
}
