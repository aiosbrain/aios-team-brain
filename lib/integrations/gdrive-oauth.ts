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
import { evaluateGdriveGrant, type GdriveGrantMode } from "@/lib/integrations/gdrive-grant-policy";

export class IncompleteGoogleOAuthPairError extends Error {}
export class InvalidGoogleOAuthInitiatorError extends Error {}
export class GoogleIdentityConflictError extends Error {}
/**
 * Google granted authority the bound consent mode does not allow, or not the authority it needs
 * (AIO-1167 R43 F3). Nothing is published; the prior connection is unchanged.
 */
export class GoogleGrantOutsideModeError extends Error {
  constructor(readonly reason: "missing" | "insufficient" | "broader") {
    super(`google_grant_${reason}`);
  }
}
/**
 * Google returned no new refresh credential and the stored one cannot be shown to fit the bound
 * mode (different/unknown recorded grant), so it may not be reused under this consent (R43 F3).
 */
export class IncompatibleStoredGoogleCredentialError extends Error {}

/** What the publication did to the connection's run state (AIO-1167 R43 F2). */
export interface GoogleDriveOAuthPublication {
  /** `disabled` when an existing paused/disconnected connection was reconnected: it stays paused. */
  status: "enabled" | "disabled";
}

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
 *
 * GRANT POLICY (AIO-1167 R43 F3). `grantMode` is the consent mode signed into the OAuth state. The
 * scopes Google granted must fit it (`evaluateGdriveGrant`), and the mode is recorded in the
 * credential (`grant_mode`) so the broker enforces the same ceiling on every refresh. A missing new
 * refresh token may reuse the stored one only when it belongs to the same subject and client AND its
 * recorded grant fits this mode — an older, broader or unrecorded grant is never relabelled as this
 * consent. The recorded scopes are always those of the refresh credential actually stored.
 *
 * RUN STATE (AIO-1167 R43 F2). Reconnecting repairs a credential; it is not Resume. The status comes
 * from the row held under the connection lock: an existing paused or disconnected (`disabled`) row
 * stays `disabled`, an enabled one stays enabled, and only a connection this publication creates
 * starts enabled. A pause committed before this publication survives it; one queued behind it wins
 * when it commits.
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
    /** The consent mode bound into the OAuth state at start. */
    grantMode: GdriveGrantMode;
    /** The scopes Google reported for this exchange. */
    scopes?: string[];
  },
  hooks: GoogleDriveOAuthPublicationHooks = {},
): Promise<GoogleDriveOAuthPublication> {
  const db = adminClient();
  const auth = { teamId: input.teamId, memberId: input.memberId };
  const subject = input.subject.startsWith("subject:") ? input.subject : `subject:${input.subject}`;
  const accountEmail = typeof input.email === "string" && input.email.trim()
    ? input.email.trim().toLowerCase()
    : null;
  // Strict on purpose: a truthy string or a missing claim from a direct caller is not verification.
  const verifiedEmail = input.emailVerified === true ? accountEmail : null;
  // The exchange's own grant must fit the bound mode, whether or not a new refresh token came with
  // it: a broader grant now means the account's credential carries broader authority.
  const exchanged = evaluateGdriveGrant(input.grantMode, input.scopes);
  if (!exchanged.ok) throw new GoogleGrantOutsideModeError(exchanged.reason);
  /** The published config over whatever the connection already holds (nothing, when it is new). */
  const publishedConfig = (prior: Record<string, unknown>, scopes: string[]) => {
    const config: Record<string, unknown> = {
      fileIds: [], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "absent" as const, access: "team" as const,
      ...prior,
      // This publisher is entered only after a verified OAuth exchange. A previous local
      // service-account mode must not survive and bypass the broker on the next execution.
      authMode: "oauth" as const,
      authenticatedAccountId: subject,
      scopeSet: scopes,
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

  return withTransaction(async () => {
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
      : await reserveGdriveIntegration(db, input.teamId, input.integrationName, publishedConfig({}, exchanged.scopes));
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
    let refreshToken = input.refreshToken ?? "";
    let credentialScopes = exchanged.scopes;
    if (!refreshToken) {
      const sameCredential = old.account_subject === subject && old.client_id === input.clientId
        && typeof old.refresh_token === "string" && Boolean(old.refresh_token);
      if (!sameCredential) throw new IncompleteGoogleOAuthPairError("incomplete_oauth_pair");
      // The stored refresh token keeps ITS grant, whatever this exchange reported: reuse it only
      // when that recorded grant was made under this same mode and still fits it.
      const stored = evaluateGdriveGrant(input.grantMode, Array.isArray(old.scopes) ? old.scopes : null);
      if (old.grant_mode !== input.grantMode || !stored.ok) {
        throw new IncompatibleStoredGoogleCredentialError("stored_credential_outside_mode");
      }
      refreshToken = String(old.refresh_token);
      credentialScopes = stored.scopes;
    }

    const config = publishedConfig(priorConfig, credentialScopes);
    const secret = JSON.stringify({
      client_id: input.clientId, client_secret: input.clientSecret,
      refresh_token: refreshToken, token_uri: "https://oauth2.googleapis.com/token",
      scopes: credentialScopes, grant_mode: input.grantMode, account_subject: subject,
    });
    // Reconnecting is not Resume: an existing row keeps the status held under its lock.
    const status: "enabled" | "disabled" = !target.reserved && connection.status !== "enabled" ? "disabled" : "enabled";
    const { id } = await upsertIntegration(db, auth, {
      type: "gdrive", name: input.integrationName, config, status,
    });
    await setIntegrationSecret(db, auth, id, secret);
    if (verifiedMemberId && verifiedEmail) {
      // Credential authority is not attribution intent (AIO-1167 R47 F1): connecting or reconnecting
      // proves the Admin may use this Google account, not that a deliberate unlink should be undone.
      // Each namespaced identity is checked on its own — a tombstoned one stays unlinked (and the
      // account stays visibly unresolved for it); an explicit Admin → Members relink remains the way
      // to restore it. A different existing owner is still a conflict, never treated as unlinked.
      const automatic = { actor: { kind: "member" as const, memberId: input.memberId }, respectTombstone: true };
      const subjectIdentity = await setMemberIdentity(db, input.teamId, verifiedMemberId, {
        provider: "gdrive", externalId: subject, email: verifiedEmail,
        handle: input.name ?? verifiedEmail,
      }, automatic);
      const emailIdentity = await setMemberIdentity(db, input.teamId, verifiedMemberId, {
        provider: "gdrive", externalId: `author-email:${verifiedEmail}`,
        email: verifiedEmail, handle: input.name ?? verifiedEmail,
      }, automatic);
      if (subjectIdentity.conflict || emailIdentity.conflict) {
        throw new GoogleIdentityConflictError("verified Google identity conflicts with an existing manual mapping");
      }
    }
    return { status };
  });
}
