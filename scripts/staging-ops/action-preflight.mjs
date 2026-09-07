/**
 * H2: ACTION prerequisites, validated before anything drains, stops, deletes or restores.
 *
 * The runner-role preflight validated identity and key material, but not the settings the action
 * actually reaches for LATER — and "later" here means after the app has been stopped and Postgres
 * replaced. Three concrete configurations could pass preflight and then fail mid-replacement:
 *
 *  - `STAGING_TESTER_CREDENTIALS_JSON` is first parsed inside `reapply-testers`, which runs AFTER
 *    the Postgres restore. Missing/invalid JSON, an empty array, a null entry or a weak password
 *    failed with staging already half-replaced — and automatic rollback re-entered the SAME install
 *    path with the SAME invalid value, so it failed again and reached recovery-required.
 *  - `STAGING_ORIGIN` and `STAGING_HEALTH_TOKEN` are first used by the boot waiter, after pair
 *    replacement. A malformed origin cannot even construct a URL.
 *  - bootstrap stops the app before it touches either, so it needs them too.
 *
 * This module is PURE: it validates supplied values and returns/throws. It performs no network I/O,
 * never prints a secret, and never rewrites a supplied password.
 *
 * Deliberately NOT required here: `STAGING_GITHUB_READ_TOKEN` / `GITHUB_REPOSITORY` for actions
 * that do not read the branch head. `readStagingHead` already validates them before the ordinary
 * install path sets anything destructive, and making rollback or bootstrap acquire a GitHub
 * dependency would add a way for recovery to fail that recovery does not need.
 */

const PASSWORD_MIN = 12;
const TOKEN_MIN = 32;
const POSTURES = new Set(["team", "external"]);

/** Actions that can drain/stop/restore, mapped to the settings each one actually reaches for. */
export const ACTION_REQUIREMENTS = Object.freeze({
  "install-ops": { origin: false, testers: false, head: false },
  verify: { origin: false, testers: false, head: false },
  install: { origin: true, testers: true, head: true },
  tick: { origin: true, testers: true, head: true },
  daemon: { origin: true, testers: true, head: true },
  rollback: { origin: true, testers: true, head: false },
  "bootstrap-rollback": { origin: true, testers: false, head: false },
});

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A permitted staging origin: HTTPS for a real Railway deployment.
 *
 * The HTTP allowance is narrow and keyed on the LOCAL ADAPTER, not on a hostname: the reproducible
 * two-environment harness serves the app over plain HTTP on a compose-network name
 * (`http://maintenance:3000`), which is not `localhost` and must not have to be. On the Railway
 * adapter — the one that talks to a real deployment — plain HTTP is refused outright.
 *
 * Embedded credentials are refused in either mode: they would be sent on every health probe and
 * would land in any error that echoed the origin.
 */
export function validateStagingOrigin(raw, { allowLocalHttp = false } = {}) {
  if (!nonBlank(raw)) return ["STAGING_ORIGIN is required before any staging lifecycle action"];
  let url;
  try { url = new URL(raw.trim()); } catch { return ["STAGING_ORIGIN is not a valid absolute URL"]; }
  const errors = [];
  if (url.protocol === "http:") {
    if (!allowLocalHttp) errors.push("STAGING_ORIGIN must use https outside the local harness adapter");
  } else if (url.protocol !== "https:") {
    errors.push(`STAGING_ORIGIN protocol ${url.protocol} is not permitted`);
  }
  if (url.username || url.password) errors.push("STAGING_ORIGIN must not embed credentials");
  if (url.pathname !== "/" && url.pathname !== "") errors.push("STAGING_ORIGIN must be an origin, not a path");
  return errors;
}

export function validateHealthToken(raw) {
  if (!nonBlank(raw)) return ["STAGING_HEALTH_TOKEN is required before any staging lifecycle action"];
  // Same length floor the app's constant-time comparison enforces, so a token that could never
  // match is rejected here rather than after the app has been replaced.
  if (raw.trim().length < TOKEN_MIN) return [`STAGING_HEALTH_TOKEN must be at least ${TOKEN_MIN} characters`];
  return [];
}

/**
 * Parse and validate the tester credential array ONCE, with the same rules the writer applies.
 * Returns the parsed entries; throws a single error naming every problem, by INDEX — never by value.
 */
export function parseTesterCredentials(raw, { maxEntries = 20 } = {}) {
  if (!nonBlank(raw)) throw new Error("STAGING_TESTER_CREDENTIALS_JSON is required before a pair can be restored");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("STAGING_TESTER_CREDENTIALS_JSON is not valid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("STAGING_TESTER_CREDENTIALS_JSON must be an array of tester objects");
  if (parsed.length === 0) throw new Error("STAGING_TESTER_CREDENTIALS_JSON must not be empty; a missing tester credential is a failed readiness check");
  if (parsed.length > maxEntries) throw new Error(`STAGING_TESTER_CREDENTIALS_JSON must not exceed ${maxEntries} entries`);

  const errors = [];
  const seen = new Map();
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push(`tester[${index}] is not an object`); return; }
    for (const field of ["email", "teamId", "memberId", "role"]) {
      if (!nonBlank(entry[field])) errors.push(`tester[${index}].${field} must be a non-blank string`);
    }
    if (typeof entry.password !== "string" || entry.password.length < PASSWORD_MIN) {
      errors.push(`tester[${index}].password must be a string of at least ${PASSWORD_MIN} characters`);
    }
    if (!POSTURES.has(entry.posture)) errors.push(`tester[${index}].posture must be exactly team or external`);
    const key = `${String(entry.teamId ?? "")}\0${String(entry.memberId ?? "")}`;
    const held = seen.get(key);
    if (held !== undefined) errors.push(`tester[${index}] duplicates the identity of tester[${held}]`);
    else seen.set(key, index);
    const byEmail = `${String(entry.teamId ?? "")}\0${String(entry.email ?? "").toLowerCase()}`;
    const heldEmail = seen.get(byEmail);
    if (heldEmail !== undefined) errors.push(`tester[${index}] duplicates the email of tester[${heldEmail}] in the same team`);
    else seen.set(byEmail, index);
  });
  if (errors.length) throw new Error(`STAGING_TESTER_CREDENTIALS_JSON is invalid: ${errors.join("; ")}`);
  return parsed;
}

/**
 * The gate itself. Throws before the caller performs ANY lifecycle mutation.
 *
 * Shape validation is not a substitute for the authoritative post-restore identity/posture check the
 * credential writer performs against the restored membership rows — that check stays where it is.
 */
export function assertActionConfiguration(env, action) {
  const requirements = ACTION_REQUIREMENTS[action];
  if (!requirements) throw new Error(`unknown importer action ${action}`);
  const errors = [];
  if (requirements.origin) {
    errors.push(...validateStagingOrigin(env.STAGING_ORIGIN, { allowLocalHttp: env.STAGING_MAINTENANCE_ADAPTER === "local" }));
    errors.push(...validateHealthToken(env.STAGING_HEALTH_TOKEN));
  }
  if (requirements.testers) {
    try { parseTesterCredentials(env.STAGING_TESTER_CREDENTIALS_JSON); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (requirements.head && env.STAGING_MAINTENANCE_ADAPTER !== "local") {
    if (!nonBlank(env.STAGING_GITHUB_READ_TOKEN)) errors.push("STAGING_GITHUB_READ_TOKEN is required for an action that reads the staging branch head");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(env.GITHUB_REPOSITORY ?? ""))) errors.push("GITHUB_REPOSITORY must be owner/repo for an action that reads the staging branch head");
  }
  if (errors.length) throw new Error(`staging ${action} refused before any lifecycle change:\n- ${errors.join("\n- ")}`);
  return true;
}
