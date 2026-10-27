/**
 * AIO-1167 R42 F6 — which Drive config fields an Admin save may write, and which belong to the
 * credential.
 *
 * The OAuth publication (`publishGoogleDriveOAuthCredential`) writes the account a connection's
 * encrypted credential belongs to: `authenticatedAccountId` (the subject the broker hands the
 * sidecar), the account email, whether Google verified it, and the granted scopes. A service-account
 * connection's first fenced provider read writes its verification status and identity. An Admin form
 * is built from an EARLIER, unlocked read, so a reconnect committing in between would let the save
 * write the previous account's subject beside the new account's credential — a config/secret
 * mismatch the sidecar cannot detect, because it compares config with config.
 *
 * So the locked owners re-derive these fields from the row they hold, never from the caller:
 * `mergeLockedGdriveCredentialFields` is applied under the connection lock by every Admin save and
 * verified publication. Pure, so its rules are unit-testable without a database.
 */

/** Written only by the OAuth credential publication. */
export const GDRIVE_OAUTH_CREDENTIAL_KEYS = [
  "authenticatedAccount",
  "authenticatedAccountEmailVerified",
  "authenticatedAccountId",
  "scopeSet",
] as const;

/** Written only by the service-account verification (or reset to pending by a scope change). */
export const GDRIVE_SERVICE_ACCOUNT_KEYS = ["serviceAccountStatus", "serviceAccountIdentity"] as const;

type Config = Record<string, unknown>;

const ROOT_FIELDS = [
  ["fileIds", "file"],
  ["folderIds", "folder"],
  ["sharedDriveIds", "drive"],
] as const;

/** `kind:id` for every selected root. */
export function gdriveRootKeys(config: Config): Set<string> {
  const keys = new Set<string>();
  for (const [field, kind] of ROOT_FIELDS) {
    const ids = config[field];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === "string") keys.add(`${kind}:${id}`);
  }
  return keys;
}

const authModeOf = (config: Config): string => String(config.authMode ?? "oauth");

function sameRoots(a: Config, b: Config): boolean {
  const left = gdriveRootKeys(a);
  const right = gdriveRootKeys(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/**
 * `next` with every credential-owned field taken from `locked` (the row held under the connection
 * lock; `{}` for a connection that does not exist yet). The caller's own values for those fields are
 * discarded, whatever they are.
 *
 *   · OAuth mode: the OAuth fields are the locked row's, when the locked row is itself OAuth; the
 *     service-account fields are dropped.
 *   · Service-account mode: the OAuth fields are dropped. The locked verification survives only when
 *     the locked row was already a service-account connection over exactly the same roots; any other
 *     save resets it to `pending` with no identity, until a fenced provider read verifies again.
 */
export function mergeLockedGdriveCredentialFields(next: Config, locked: Config): Config {
  const merged: Config = { ...next };
  for (const key of [...GDRIVE_OAUTH_CREDENTIAL_KEYS, ...GDRIVE_SERVICE_ACCOUNT_KEYS]) delete merged[key];
  if (authModeOf(next) === "oauth") {
    if (authModeOf(locked) === "oauth") {
      for (const key of GDRIVE_OAUTH_CREDENTIAL_KEYS) if (key in locked) merged[key] = locked[key];
    }
    return merged;
  }
  const verificationHolds = authModeOf(locked) === "service_account" && sameRoots(next, locked);
  merged.serviceAccountStatus = verificationHolds ? (locked.serviceAccountStatus ?? "pending") : "pending";
  if (verificationHolds && typeof locked.serviceAccountIdentity === "string") {
    merged.serviceAccountIdentity = locked.serviceAccountIdentity;
  }
  return merged;
}

/**
 * The roots an UNVERIFIED OAuth save would add relative to the locked row. An Admin save that needs
 * no provider proof may only keep or remove roots; a root missing from the locked row means the form
 * was built from a stale read (or is a new root that needed the verified path). Empty for
 * service-account mode, whose new roots are verified by the next fenced provider read instead.
 */
export function unverifiedOauthRoots(next: Config, locked: Config): string[] {
  if (authModeOf(next) !== "oauth") return [];
  const held = gdriveRootKeys(locked);
  return [...gdriveRootKeys(next)].filter((key) => !held.has(key));
}
