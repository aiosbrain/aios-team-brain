/**
 * credential-plan.mjs — decide whether to (re)provision the local admin's password.
 *
 * Its own module for two reasons, both learned the hard way:
 *
 * 1. TESTABILITY. `docker/bootstrap.mjs` calls `process.exit(1)` at module scope when DATABASE_URL
 *    is unset, so importing it from a test kills the worker. A decision worth testing cannot live
 *    inside a module that refuses to be imported.
 *
 * 2. THE TRAP IT ENCODES. `docker/bootstrap.mjs` runs on EVERY container start, so re-provisioning
 *    the credential each time silently resets the login on every `docker compose up` — including
 *    over a password the user later changed in Admin.
 *
 *    The obvious fix — call `create-member` but omit `--password` — is WRONG and worse. `admin.ts`
 *    does `(flags.password) || randomPassword()`, so `create-member` ALWAYS writes a credential;
 *    dropping the flag installs a random password nobody ever sees, locking the user out entirely.
 *    Measured on a real restart: the stored hash changed while bootstrap reported "unchanged".
 *
 *    Hence "skip" here means "do not run the command at all", never "run it without the flag".
 */
import { randomBytes } from "node:crypto";

const defaultGenerate = () => randomBytes(12).toString("base64url");

/**
 * @param {{hasCredential: boolean, adminPassword?: string, generate?: () => string}} input
 * @returns {{action: "skip"|"create", password: string|null}}
 */
export function credentialPlan({ hasCredential, adminPassword, generate = defaultGenerate }) {
  if (hasCredential) return { action: "skip", password: null };
  return { action: "create", password: adminPassword || generate() };
}
