/**
 * Service-identity guard — the runtime backstop against THIS (aios-team-brain) app
 * being deployed onto another project's Railway service. It is the symmetric mirror
 * of Kula's `src/lib/service-guard.ts`; the incident below is why both must exist.
 *
 * 2026-06-27 incident: an aios-team-brain Conductor worktree was `railway up`'d onto
 * the **kula** Railway service. That deploy inherited the kula service's env (incl.
 * DATABASE_URL) and its preDeployCommand — `npm run pg:schema` — ran THIS repo's
 * schema.sql against Kula's PRODUCTION database, additively injecting ~33 foreign
 * tables and taking Kula's WhatsApp webhook offline for ~24h.
 *
 * Railway injects `RAILWAY_SERVICE_NAME` into every deploy, reflecting the SERVICE the
 * container runs on (not the app's own name). So if this code is ever running on a
 * service that isn't one of AIOS's, we abort BEFORE opening a DB connection.
 *
 * Relationship to the other guard: `scripts/railway-deploy-guard.sh` is a PreToolUse
 * hook that blocks `railway up`/`redeploy`/`down`/`delete` from the AGENT's shell.
 * That only fires inside Claude Code with the hook active — it does nothing for a
 * `railway up` typed by a human, or any other path that lands this code on a foreign
 * service. THIS module is the runtime belt-and-suspenders: even if a foreign deploy
 * happens, the schema load refuses to run against the wrong database.
 *
 * Only enforced when `RAILWAY_SERVICE_NAME` is present (i.e. on Railway). Local dev,
 * tests, CI, and one-off scripts leave it unset and run unguarded.
 */

/**
 * True when `name` is one of AIOS's own Railway services.
 *
 * Default policy accepts `aios` and any `aios-*` service (covers the production
 * `aios-team-brain` service and any future `aios-web` / `aios-worker` split without
 * extra config). Override with `AIOS_RAILWAY_SERVICES` (comma-separated, exact-match)
 * if AIOS is renamed or its services don't share the `aios` prefix.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isAiosService(name) {
  const override = process.env.AIOS_RAILWAY_SERVICES;
  if (override && override.trim()) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(name);
  }
  return name === "aios" || name.startsWith("aios-");
}

/**
 * Throw if this process is running on a Railway service that isn't AIOS's.
 * No-op when `RAILWAY_SERVICE_NAME` is unset (off-Railway).
 *
 * @param {string} context short verb phrase for the error, e.g. `'load the AIOS schema'`.
 * @returns {void}
 */
export function assertServiceIdentity(context) {
  const actual = process.env.RAILWAY_SERVICE_NAME;
  if (!actual) return; // not on Railway — nothing to assert

  if (!isAiosService(actual)) {
    throw new Error(
      `[service-guard] Refusing to ${context}: this is the aios-team-brain app but it is ` +
        `running on Railway service '${actual}', which is not an AIOS service. ` +
        `This almost always means the WRONG app was deployed onto this service ` +
        `(the 2026-06-27 incident, when an aios worktree was railway-up'd onto Kula). ` +
        `Aborting before touching the database. If AIOS was legitimately renamed or ` +
        `split, set AIOS_RAILWAY_SERVICES (comma-separated) to the allowed service names.`
    );
  }
}
