import "server-only";
import type { DbClient } from "@/lib/db/types";
import { syncProviderIdentities, type ProviderIdentitySyncResult } from "@/lib/identity/provider-sync";

/**
 * Slack → member reconciliation: thin wrapper over the shared `syncProviderIdentities` (provider
 * "slack"). Maps each Slack user whose email matches a roster member to a `member_identities` row
 * keyed by the Slack user id, so Slack content attributes to the right person. Needs the
 * `users:read.email` scope for emails; without it this is a no-op and admins map identities manually.
 *
 * It is also the ADMISSION boundary for that automatic link (AIO-1170 AC-07): only an account Slack
 * positively classified as human is handed to the shared writer. The writer links by email and knows
 * nothing about classification, so a bot, an app or an unclassified account with a roster-matching
 * email would otherwise become somebody's Slack identity.
 */

/**
 * One Slack directory record: the single DTO `SlackClient.usersDetailed()` returns and this adapter
 * accepts. The five classification facts are present only when Slack sent a literal boolean; a
 * missing one is UNKNOWN, never false.
 */
export interface SlackUser {
  id: string;
  displayName: string;
  email?: string;
  /** `is_bot`. */
  isBot?: boolean;
  /** `is_app_user`: an authorized user of the calling app. Not proof of a bot, and still excluded. */
  isAppUser?: boolean;
  /** `deleted` (deactivated). Descriptive: it does not decide whether the account is a person. */
  deleted?: boolean;
  /** `is_restricted` (guest). Descriptive. */
  isRestricted?: boolean;
  /** `is_ultra_restricted` (single-channel guest). Descriptive. */
  isUltraRestricted?: boolean;
}

export type SlackIdentitySyncResult = ProviderIdentitySyncResult;

/**
 * Slack's own service account. Slack reports it with `is_bot: false`, so it is excluded by id rather
 * than by falsifying that flag — as a raw id or as the user part of a workspace-qualified one.
 */
const SLACK_SERVICE_ACCOUNT_ID = "USLACKBOT";

/**
 * A usable directory id, or null. A null or non-object entry cannot supply one, and an id that is
 * missing, not a string, or blank is rejected WITHOUT being coerced — this runs before any string
 * operation, because a direct caller can hand over malformed runtime data.
 */
function directoryId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * The key two occurrences of one account share: the full id, trimmed, with ASCII letters upper-cased
 * and nothing else changed (no locale or Unicode case mapping). It is for COMPARISON only — the id
 * that is forwarded is never rewritten — and it keeps the workspace prefix, so a raw id, a qualified
 * id and the same user id in two workspaces stay three different accounts.
 */
function admissionKey(id: string): string {
  return id.trim().replace(/[a-z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 32));
}

/** The service account, as a raw id or as the user component of `WORKSPACE:USER`. */
function isServiceAccount(key: string): boolean {
  const colon = key.indexOf(":");
  const userComponent = colon >= 0 && colon === key.lastIndexOf(":") ? key.slice(colon + 1) : key;
  return userComponent === SLACK_SERVICE_ACCOUNT_ID;
}

/**
 * The records that may be linked automatically, in their original order and unchanged.
 *
 * Human means BOTH flags are the literal boolean false. A true flag is a bot or an app; anything
 * else — a missing, partial, null or wrongly typed flag — is unknown, and unknown is not human. Guest
 * and deactivation flags are descriptive and are not consulted. When any occurrence of an account
 * fails, every occurrence of that account is omitted, so a human-looking duplicate that differs only
 * by case or outer whitespace cannot carry a conflicting observation past the check.
 */
function admittedHumans(users: readonly unknown[]): SlackUser[] {
  const refused = new Set<string>();
  const candidates: { user: SlackUser; key: string }[] = [];
  for (const entry of users) {
    const id = directoryId(entry);
    if (id === null) continue;
    const user = entry as SlackUser;
    const key = admissionKey(id);
    if (user.isBot === false && user.isAppUser === false && !isServiceAccount(key)) candidates.push({ user, key });
    else refused.add(key);
  }
  return candidates.filter(({ key }) => !refused.has(key)).map(({ user }) => user);
}

export async function syncSlackIdentities(
  admin: DbClient,
  teamId: string,
  users: SlackUser[]
): Promise<SlackIdentitySyncResult> {
  // Omitted BEFORE the shared writer: it would link an excluded account by email all the same. An
  // all-excluded directory hands it nothing, which is its existing no-op — zeros and no database work.
  const admitted = admittedHumans(users);
  // Exact email only: Slack attribution must never rest on the local-part → handle guess (spec AC-07).
  return syncProviderIdentities(admin, teamId, "slack", admitted, { exactEmailOnly: true });
}
