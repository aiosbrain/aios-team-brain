/**
 * deploy-policy.mjs — the two decisions `docker/bootstrap.mjs` makes from the environment
 * before it touches the database: whether to seed the demo, and what team slug to use.
 *
 * Its own module for the same reason as `credential-plan.mjs`: `docker/bootstrap.mjs` calls
 * `process.exit(1)` at module scope when DATABASE_URL is unset, so importing it from a test
 * kills the worker. A decision worth testing cannot live inside a module that refuses to be
 * imported.
 */

const FALSEY = new Set(["false", "0", "no", "off"]);
const TRUTHY = new Set(["true", "1", "yes", "on"]);

/** Hosts that mean "this brain is not reachable from the internet". */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

/**
 * Is `appUrl` a local address?
 *
 * Unset counts as local: bootstrap's own default is `http://localhost:3000`, and `compose.yml`
 * sets `APP_URL=http://localhost:${APP_PORT}` — so `docker compose up` keeps behaving exactly as
 * it did. Anything we cannot parse counts as PUBLIC, because the two mistakes are not
 * symmetrical: calling a public URL local ships a published brain with a known password, while
 * calling a local URL public only asks the operator for one explicit opt-in.
 *
 * @param {string | undefined} appUrl
 * @returns {boolean}
 */
export function isLocalAppUrl(appUrl) {
  const raw = (appUrl ?? "").trim();
  if (!raw) return true;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false; // unparseable — treat as public
  }
  if (LOCAL_HOSTS.has(host)) return true;
  return host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * Decide whether to seed the Northwind demo team (and its shared-password admin).
 *
 * WHY THIS IS NOT JUST `SEED_DEMO !== "false"`. The demo admin is a documented, hardcoded
 * credential (`admin@demo.local` / `aios-demo-password`) that bootstrap PRINTS into the deploy
 * log. That is right for a laptop and wrong for anything with a public URL — and the path that
 * reaches a public URL is the easy one to fall into: deploying this repo by hand without
 * `TEAM_SLUG` (the Railway template sets it; a manual deploy has no reason to know it exists)
 * lands here with `NODE_ENV=production` from the Dockerfile and a `*.up.railway.app` address.
 * The default has to be safe there, so on a production build with a non-local APP_URL the demo
 * becomes explicit-opt-in rather than default-on.
 *
 * `SEED_DEMO=false` still wins everywhere, and now so do `0` / `no` / `off` — the previous
 * exact-string check silently seeded on any of them.
 *
 * WHAT THIS DOES NOT CATCH, so nobody reads it as a complete answer: `NODE_ENV=production` comes
 * from the Dockerfile, so the gate travels with the image — running bootstrap bare-metal with
 * NODE_ENV unset still seeds. And a deployment whose APP_URL stays `localhost` because a reverse
 * proxy fronts it is indistinguishable from a laptop from in here. Both are the same class of
 * limit: this reads the environment the operator configured, and cannot audit the network.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{seed: boolean, publicProduction: boolean, reason: "disabled"|"opt-in-required"|"enabled"}}
 */
export function demoSeedDecision(env = process.env) {
  const flag = (env.SEED_DEMO ?? "").trim().toLowerCase();
  const publicProduction = env.NODE_ENV === "production" && !isLocalAppUrl(env.APP_URL);

  if (FALSEY.has(flag)) return { seed: false, publicProduction, reason: "disabled" };
  if (publicProduction && !TRUTHY.has(flag)) {
    return { seed: false, publicProduction, reason: "opt-in-required" };
  }
  return { seed: true, publicProduction, reason: "enabled" };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Turn whatever the operator typed into a slug `lib/admin/teams.ts` will accept.
 *
 * WHY NORMALISE INSTEAD OF FAILING. `TEAM_SLUG` is collected by a Railway deploy form with no
 * input validation, so "Acme Corp" is the obvious thing to type. `createTeam` rejects it,
 * `scripts/admin.ts` calls `die()`, the container exits non-zero, Railway restarts it ten times
 * and gives up — a failed deployment against a half-provisioned database, for a space. Ten
 * restarts of an unrecoverable error is a worse answer to a typo than fixing the typo.
 *
 * The slug is not cosmetic — it is in every URL the operator will bookmark (`/t/<slug>`) — so a
 * normalised value is always REPORTED, never applied quietly. Returns `changed` so the caller
 * can say what it did, and `slug: null` when nothing usable is left (e.g. "!!!"), which is the
 * one case that still has to fail loudly rather than invent a name.
 *
 * @param {string | undefined} raw
 * @returns {{slug: string | null, changed: boolean}}
 */
export function normalizeTeamSlug(raw) {
  const input = String(raw ?? "").trim();
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics: "Café" → "cafe", not "caf-"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug || !SLUG_RE.test(slug)) return { slug: null, changed: false };
  return { slug, changed: slug !== input };
}
