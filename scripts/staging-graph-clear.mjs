/**
 * STGENV-4 — clear STAGING's graph after a Postgres refresh. Runbook: docs/OPS.md §11.
 * Design + why the automated version was declined: docs/design/staging-graph-reset.md.
 *
 * WHY THIS IS A SCRIPT AND NOT A SHELL LINE IN THE RUNBOOK. It was a shell line, and the pre-push
 * review proved it never fired: `railway ssh -- sh -c '…'` joins argv with spaces and wraps the
 * RESULT in its own `sh -c`, so the inner `sh -c echo "$GRAPHITI_URL" | grep …` ran a bare `echo`,
 * the grep saw an empty line, and the command printed "REFUSED" and exited 0 on a correctly
 * configured staging. `curl` is not in the image either (`node:20-bookworm-slim`, no `apt-get`).
 * A one-liner in a doc cannot be tested; this can, and is.
 *
 * WHY IT IS PURE NODE WITH `fetch` AND NOTHING ELSE. It needs no database and no bolt driver — the
 * whole operation is one HTTP POST. That is what makes it a script rather than the service two
 * review rounds declined: no advisory lease, no ledger read, no enumeration, no `server-only`
 * TypeScript it cannot import.
 *
 * TWO IDENTITY CHECKS, AND THEY ARE ALL THAT PROTECT YOU. `POST /clear` is an UNSCOPED whole-graph
 * wipe, and the sidecar has NO authentication (the credential people think of, `NEO4J_AUTH`, is
 * Neo4j's — not the REST server's).
 *
 * The HOST check proves the target is a private sidecar: Railway's DNS is environment-scoped, so
 * `*.railway.internal` can only be the sidecar of the environment this process runs in, and a
 * production one reached from elsewhere would need a public domain, which cannot spell that host.
 *
 * The ENVIRONMENT check proves WHICH environment that is. The host alone does not: in a production
 * shell, `graphiti.railway.internal` is production's own sidecar and passes. Review found exactly
 * that, after the first version shipped with the host check only.
 *
 * Both defend against ACCIDENT, not intent. Setting the environment variable by hand in a production
 * shell is a deliberate act and no check here stops it.
 *
 * EXIT CODES ARE DISTINCT ON PURPOSE. The reviewed shell line used `A && B || C`, so every failure —
 * sidecar down, 5xx, missing binary — printed "REFUSED: not an internal host" and exited 0. The line
 * called "the whole safety argument" was also the line whose failure message lied.
 *   0  cleared
 *   1  the request failed (the graph may or may not be cleared — re-run and see)
 *   2  REFUSED: not the staging environment, or the target is not an internal host, or either of
 *      RAILWAY_ENVIRONMENT_NAME / GRAPHITI_URL is unset
 */

/** Hosts we are willing to send an unscoped wipe to. Environment-scoped private DNS only. */
const INTERNAL_SUFFIX = ".railway.internal";

/**
 * TWO conditions, not one, because the host proves the wrong thing on its own.
 *
 * `*.railway.internal` proves "this environment's sidecar" — NOT "staging's sidecar". An operator in
 * an already-open production shell, or one who types `-e production`, passes the host check with
 * `graphiti.railway.internal` and wipes PRODUCTION. The review found exactly that, and it is a
 * contradiction this file introduced against its own design doc, which named both bindings.
 *
 * `RAILWAY_ENVIRONMENT_NAME` is platform-injected into every container. It is weaker than the host
 * check on its own (an operator can rename an environment) and the host check is weaker than it (a
 * shell can be in the wrong environment) — which is exactly why both are required. Their failure
 * modes are disjoint.
 */
export const REQUIRED_ENVIRONMENT = "staging";

/**
 * The refusal decision, pure so it is testable without a network. Returns null to proceed, or the
 * operator-facing reason to refuse. Parses rather than pattern-matching the raw string: a substring
 * check would accept `https://evil.com/?x=.railway.internal` and `http://a.railway.internal.evil.com`.
 */
export function environmentRefusalFor(envName) {
  const name = (envName ?? "").trim();
  if (name === "") {
    return (
      "RAILWAY_ENVIRONMENT_NAME is not set — cannot prove this is staging. If the shell does not " +
      "carry the service environment, that is the thing to fix; do not work around it."
    );
  }
  if (name !== REQUIRED_ENVIRONMENT) {
    return `RAILWAY_ENVIRONMENT_NAME is ${JSON.stringify(name)}, not ${JSON.stringify(REQUIRED_ENVIRONMENT)} — refusing.`;
  }
  return null;
}

export function refusalFor(rawUrl) {
  const raw = (rawUrl ?? "").trim();
  if (raw === "") return "GRAPHITI_URL is not set — nothing to clear, and no target to verify.";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `GRAPHITI_URL is not a URL: ${JSON.stringify(raw)}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `GRAPHITI_URL is not http(s): ${JSON.stringify(raw)}`;
  }
  if (!url.hostname.endsWith(INTERNAL_SUFFIX)) {
    return (
      `GRAPHITI_URL host ${JSON.stringify(url.hostname)} is not ${INTERNAL_SUFFIX} — refusing. ` +
      `Only this environment's own sidecar is reachable on private DNS; a public host could be any ` +
      `environment's, including production's.`
    );
  }
  return null;
}

/** `${origin}/clear`, built from the parsed URL so a trailing slash or a path cannot smuggle. */
export function clearEndpoint(rawUrl) {
  return new URL("/clear", rawUrl).toString();
}

export async function main(env = process.env, fetchImpl = fetch, log = console) {
  // Environment FIRST: a production shell must be told what is wrong before anything reads a URL.
  const envRefusal = environmentRefusalFor(env.RAILWAY_ENVIRONMENT_NAME);
  if (envRefusal) {
    log.error(`REFUSED: ${envRefusal}`);
    return 2;
  }
  const refusal = refusalFor(env.GRAPHITI_URL);
  if (refusal) {
    log.error(`REFUSED: ${refusal}`);
    return 2;
  }
  log.info(`environment: ${env.RAILWAY_ENVIRONMENT_NAME}`);
  const endpoint = clearEndpoint(env.GRAPHITI_URL);
  log.info(`clearing the whole graph at ${endpoint} …`);
  let res;
  try {
    res = await fetchImpl(endpoint, { method: "POST" });
  } catch (e) {
    log.error(`FAILED: could not reach ${endpoint}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!res.ok) {
    log.error(`FAILED: ${endpoint} returned ${res.status}`);
    return 1;
  }
  log.info(`cleared. Restart the staging app next — arcs are memory-first and a warm process holds a`);
  log.info(`prior for up to 48h, so without a restart staging shows pre-reset arcs as fresh.`);
  return 0;
}

// Argv-guarded so importing this file in a test does not run it.
if (process.argv[1] && process.argv[1].endsWith("staging-graph-clear.mjs")) {
  main().then((code) => process.exit(code));
}
