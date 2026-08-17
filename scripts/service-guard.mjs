/**
 * Service-identity guard — the runtime backstop against THIS (aios-team-brain) app writing
 * its schema into a database that belongs to something else.
 *
 * WHY IT EXISTS — the 2026-06-27 cross-project deploy incident. A worktree of this repo was
 * `railway up`'d onto a Railway service belonging to an unrelated project. The deploy
 * inherited THAT service's environment — including its DATABASE_URL — and ran a
 * preDeployCommand (`npm run pg:schema`), so this repo's schema.sql was applied to a live
 * production database that was never ours: dozens of foreign tables added to a running
 * system, and a long outage for the people who owned it. Nobody reads a deploy log fast
 * enough to interrupt that, so the abort has to happen in-process, before the first
 * connection is opened.
 *
 * Railway injects `RAILWAY_SERVICE_NAME` into every deploy, reflecting the SERVICE the
 * container runs on (not the app's own name). Comparing it against the services this app is
 * supposed to run on is the whole check.
 *
 * WHEN IT ENFORCES — read this before changing it. This repo is public and self-hosted by
 * third parties, so "the service name doesn't start with aios" cannot mean "abort": an
 * operator who names their Railway service after their own company would get an
 * unrecoverable failed release, from a pre-deploy hook, with an error about a project they
 * have never heard of. Enforcement is therefore scoped to deploys we can positively identify
 * as AIOS-operated, through two markers:
 *
 *   1. `RAILWAY_PROJECT_ID` === `AIOS_RAILWAY_PROJECT_ID` below. Railway injects the project
 *      id into every deploy; it is platform-owned and immutable, and it is not a variable an
 *      operator can forget to set or prune as "unused". That property is exactly why it beats
 *      the obvious alternative — an opt-in flag such as `AIOS_DEPLOY=1`. An opt-in flag fails
 *      OPEN and does so silently: the day someone tidies the service's variables or rebuilds
 *      the environment from a template, the guard is still in the code, still green in CI, and
 *      simply never runs in production again. Nobody gets an alert for a check that stopped
 *      happening. A project id cannot be forgotten into absence, so protection on AIOS's own
 *      service cannot be switched off by accident. (It is not a credential — project ids appear
 *      in dashboard URLs and grant nothing on their own — so pinning it in a public repo is
 *      free. A fork changes this one line.)
 *   2. `AIOS_RAILWAY_SERVICES` set — an explicit operator opt-in, which also lets any
 *      self-hoster turn the same protection on for their own deploy. It can only ADD
 *      enforcement: deleting it never disables the guard on AIOS's own service, because
 *      marker 1 still fires there.
 *
 * KNOWN LIMIT, stated so nobody assumes more than this gives. A deploy pushed into a
 * DIFFERENT Railway project inherits that project's environment, so no variable AIOS sets can
 * survive the hop — marker 1 is not visible there and this guard will not fire. Nothing
 * running in-process can distinguish that case from a legitimate self-host, because the code
 * is identical and public; claiming otherwise would be how the cross-project case comes to be
 * treated as covered when it is not. It is covered instead by the layers that act BEFORE the
 * deploy: the deny-list + PreToolUse hook (`scripts/railway-deploy-guard.sh`), the read-only
 * Railway CLI rule (CLAUDE.md §6), `scripts/railway-link-check.sh`, a project-scoped
 * `RAILWAY_TOKEN` (docs/OPS.md §4), and the receiving app carrying this same guard for itself.
 * What this module still covers alone: any deploy inside the AIOS project that lands on a
 * service it does not belong on.
 *
 * Off Railway (`RAILWAY_SERVICE_NAME` unset) it is always a no-op — local dev, tests, CI, and
 * one-off scripts run unguarded.
 */

/**
 * AIOS's own Railway project id. Platform-injected and immutable — see the header for why
 * this, rather than an opt-in flag, is the marker that decides whether the guard enforces.
 */
export const AIOS_RAILWAY_PROJECT_ID = "a488ce13-3895-4ce8-857f-859eb40327c6";

/** Default service allow-list when `AIOS_RAILWAY_SERVICES` is not set. */
const DEFAULT_POLICY = "aios / aios-*";

/**
 * True when `name` is one of the services this app is allowed to run on.
 *
 * Default policy accepts `aios` and any `aios-*` service (covers the production
 * `aios-team-brain` service and any future `aios-web` / `aios-worker` split without extra
 * config). `AIOS_RAILWAY_SERVICES` (comma-separated, exact-match) replaces that default, for
 * a rename, a split, or a self-hoster opting in with their own service names.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isAiosService(name, env = process.env) {
  const override = env.AIOS_RAILWAY_SERVICES;
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
 * Which marker (if any) says this deploy is one whose service identity we may enforce.
 * `null` means "not ours to judge" — a third-party self-host, which must never be blocked.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"aios-project" | "opt-in" | null}
 */
export function enforcementMarker(env = process.env) {
  if ((env.RAILWAY_PROJECT_ID ?? "").trim() === AIOS_RAILWAY_PROJECT_ID) return "aios-project";
  if ((env.AIOS_RAILWAY_SERVICES ?? "").trim()) return "opt-in";
  return null;
}

/** Human-readable description of what the current policy allows, for the error message. */
function describeAllowed(env) {
  const override = env.AIOS_RAILWAY_SERVICES;
  return override && override.trim() ? override.trim() : DEFAULT_POLICY;
}

/**
 * Throw if this process is running on a Railway service it is not allowed to run on.
 *
 * No-op when `RAILWAY_SERVICE_NAME` is unset (off Railway) or when no enforcement marker is
 * present (a third-party self-host — see the header).
 *
 * @param {string} context short verb phrase for the error, e.g. `'load the AIOS schema'`.
 * @param {{env?: NodeJS.ProcessEnv, logger?: {log: (msg: string) => void}}} [opts]
 * @returns {void}
 */
export function assertServiceIdentity(context, { env = process.env, logger = console } = {}) {
  const actual = env.RAILWAY_SERVICE_NAME;
  if (!actual) return; // not on Railway — nothing to assert

  if (!enforcementMarker(env)) {
    // Say so out loud. A guard that decided not to run is otherwise indistinguishable in the
    // deploy log from a guard that ran and passed.
    logger.log(
      `[service-guard] Running on Railway service '${actual}'. This deploy carries no AIOS ` +
        `service marker, so the service-identity check is not enforced. To enforce it, set ` +
        `AIOS_RAILWAY_SERVICES to a comma-separated list of the services this app may run on.`
    );
    return;
  }

  if (!isAiosService(actual, env)) {
    throw new Error(
      `[service-guard] Refusing to ${context}: this app is running on Railway service ` +
        `'${actual}', which is not one of the services it is allowed to run on ` +
        `(allowed: ${describeAllowed(env)}). Aborting before opening a database connection, so ` +
        `nothing is written to a database that may belong to a different app. If this service ` +
        `was legitimately renamed or split, set AIOS_RAILWAY_SERVICES to a comma-separated ` +
        `list of the allowed service names and redeploy.`
    );
  }
}
