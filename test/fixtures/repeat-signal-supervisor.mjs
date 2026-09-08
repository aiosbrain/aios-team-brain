#!/usr/bin/env node
/**
 * A REAL subprocess running the REAL `supervise`, so real OS signals can be delivered to it.
 *
 * `process.emit(signal)` drives the JavaScript listener but cannot test what this regression is
 * about: the DEFAULT OS ACTION that a `process.once` handler restores the moment it fires. Only an
 * actual second `kill(pid, 'SIGTERM')` against a process whose listener has been consumed shows the
 * supervisor dying mid-cleanup — so the supervisor has to be its own process.
 *
 * Containment is deliberately held PENDING by injecting a `kill` that suppresses delivery to the
 * owned group while leaving signal-0 (liveness) genuinely real. That models an uncontained live
 * workload — the state in which the fence is SUPPOSED to keep its healthy lock and retry — without
 * claiming that a real SIGKILL can be ignored. Delivery is restored when the release file appears,
 * which is how the test proves the fence still completes normally afterwards.
 *
 * argv: <payload-port> <release-file> [database-url]
 *
 * With a DATABASE-URL the fence opens a REAL Postgres session and takes the REAL shared data-use
 * lock, which is what lets the data-mechanics tier observe lock RETENTION from a third session
 * rather than trusting a fake's `end()` bookkeeping. Without it the fake session below is used, and
 * the property under test is the handler lifetime alone.
 *
 * stdout protocol (one JSON object per line):
 *   {"event":"payload","pgid":N}   the owned group, so the test can assert on and clean up
 *   {"event":"pending"}            containment failed at least once; the fence is retrying
 *   {"event":"released"}           the fence connection ended — the shared lock is given up
 *   {"event":"exit","code":N}      supervise() returned
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { supervise } from "../../scripts/staging-ops/startup-fence.mjs";

const [portText, releaseFile, databaseUrl] = process.argv.slice(2);
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** Real liveness, suppressed termination — until the release file exists. */
const injectedKill = (target, signal) => {
  if (signal === 0) return process.kill(target, 0);
  if (existsSync(releaseFile)) return process.kill(target, signal);
  return undefined;
};

let pgid = null;
const spawnImpl = (file, args, options) => {
  const child = spawn(file, args, options);
  pgid = child.pid ?? null;
  say({ event: "payload", pgid });
  return child;
};

/**
 * A healthy lock SESSION with no database. The property under test is the fence's signal-handler
 * lifetime and the ordering of `end` relative to verified containment, and a real Postgres would
 * add nothing to either. `end` is the observable release of the shared lock.
 */
const client = {
  connect: async () => {},
  query: async (sql) => {
    const text = String(sql);
    // M4 made the shared data-use acquisition NON-BLOCKING: it now asks `pg_try_advisory_lock_shared`
    // and requires `acquired === true`. This must be answered explicitly and FIRST — the acquisition
    // is the first query the fence issues, and a generic `{}` row reads as "refused", so the fence
    // throws before spawning anything and this fixture proves nothing.
    if (text.includes("advisory_lock_shared")) return { rows: [{ acquired: true }] };
    if (text.includes("to_regclass")) return { rows: [{ journal_table: "staging_ops.refresh_journal" }] };
    if (text.includes("refresh_journal")) return { rows: [{ state: "ready", run_id: "run-1" }] };
    // A query this fixture does not model is a CHANGE IN THE CONTRACT, not a default. Returning an
    // empty row for it is how the acquisition above went unnoticed; failing loudly puts the reason on
    // the driver's stderr, which the test now reports.
    throw new Error(`repeat-signal fixture has no modelled answer for: ${text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  },
  end: async () => { say({ event: "released" }); },
  on: () => {},
};

/**
 * The REAL session, when a database URL is supplied. `end` is wrapped only to announce the release
 * on the same stdout protocol — the lock's actual lifetime belongs to the session, and the
 * data-mechanics test observes it from a THIRD connection rather than believing this line.
 */
function realClient() {
  const real = new pg.Client({ connectionString: databaseUrl });
  const end = real.end.bind(real);
  real.end = async () => { const result = await end(); say({ event: "released" }); return result; };
  return real;
}

const env = {
  STAGING_DATA_MODE: "copy-ready",
  DATABASE_URL: databaseUrl || "postgres://app:pw@staging-pg:5432/brain",
  STAGING_OPS_ENVIRONMENT_ID: "staging-local",
  RAILWAY_ENVIRONMENT_ID: "staging-local",
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  PATH: process.env.PATH,
};

const payload = fileURLToPath(new URL("./owned-workload-wrapper.mjs", import.meta.url));

// Short retry interval so "the fence is still retrying" is observable quickly; the retry BEHAVIOUR
// is the fence's own, not this fixture's.
supervise([process.execPath, payload, portText, "0", "0"], {
  env, createClient: () => (databaseUrl ? realClient() : client), spawnImpl, kill: injectedKill,
  cleanupRetryMs: 100,
  stopOptions: { graceMs: 100, verifyMs: 200 },
})
  .then(({ code }) => { say({ event: "exit", code }); process.exit(0); })
  .catch((error) => { say({ event: "error", detail: String(error?.message ?? error) }); process.exit(1); });

// "Containment is pending" is NOT reported by this fixture: the fence emits its own
// `fence-containment-pending` receipt on the same stdout, and the test waits on that. A marker
// invented here could be true while the fence's own state was something else.
