import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapRollback } from "../scripts/staging-ops/importer.mjs";

/**
 * L1 / L3 — ADMISSION IS THE BOUNDARY, AND A REFUSAL BEFORE IT CHANGES NOTHING.
 *
 * Two defects, one shape. The bootstrap received the shutdown signal but never checked it before its
 * fresh/resume draining transitions, so the earliest refusal was a subprocess spawn inside the
 * capture — after the journal had entered draining and both services had been stopped. And its catch
 * restarts "whenever `current` exists", where `current` is assigned from the interruption record
 * BEFORE the configured mode is validated: an invalid retry therefore transitioned the journal and
 * issued a deployment despite never having been admitted to anything.
 *
 * The assertions below are about what did NOT happen: no journal UPDATE, no stop, no deploy.
 */

const SHA = "a".repeat(40);

const ENV = {
  STAGING_MAINTENANCE_ADAPTER: "local",
  STAGING_BOOTSTRAP_MODE: "legacy-pg-only",
  DATABASE_URL: "postgres://app:pw@staging-pg.railway.internal:5432/brain",
  RAILWAY_ENVIRONMENT_ID: "env-staging",
  STAGING_OPS_ENVIRONMENT_ID: "env-staging",
  STAGING_APP_SERVICE_ID: "svc-app",
  STAGING_GRAPHITI_SERVICE_ID: "svc-graphiti",
  STAGING_ORIGIN: "http://maintenance:3000",
  STAGING_HEALTH_TOKEN: "t".repeat(40),
} as unknown as NodeJS.ProcessEnv;

/** A journal with no bootstrap record at all: the FRESH branch. */
const freshJournal = () => ({
  singleton: true, state: "failed", run_id: null, last_ready_run_id: null,
  bootstrap_run_id: null, bootstrap_phase: null,
});

/** A journal carrying a resumable interruption record: the RESUME branch. */
const resumeJournal = (over: Record<string, unknown> = {}) => ({
  singleton: true, state: "failed", run_id: "bootstrap-1", last_ready_run_id: null,
  bootstrap_run_id: "bootstrap-1", bootstrap_phase: "stopping",
  bootstrap_deployment_id: "dep-baseline", bootstrap_commit: SHA,
  bootstrap_mode: "legacy-pg-only", bootstrap_environment_id: "env-staging",
  bootstrap_app_service_id: "svc-app",
  ...over,
});

/**
 * The lock-owning session, answering the four statement shapes this path issues. Every
 * `UPDATE staging_ops.refresh_journal` is recorded, because "the journal was not moved" is the
 * property under test and it must be observed rather than inferred.
 */
const fakeClient = (journal: Record<string, unknown>) => {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    updates,
    connectionParameters: { host: "staging-pg.railway.internal", port: 5432, database: "brain", user: "app" },
    connection: { stream: { remoteAddress: "10.0.0.7" } },
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("pg_try_advisory_lock") || text.includes("pg_advisory_lock")) return { rows: [{ acquired: true }] };
      if (text.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (text.includes("SELECT * FROM staging_ops.refresh_journal")) return { rows: [journal] };
      if (text.includes("inet_server_addr")) {
        return { rows: [{ database: "brain", server_address: "10.0.0.7", server_port: 5432, backend_pid: 41 }] };
      }
      if (/UPDATE staging_ops\.refresh_journal/.test(text)) {
        updates.push({ sql: text, params });
        return { rows: [{ ...journal, state: params[1] ?? journal.state }] };
      }
      if (text.includes("set_config")) return { rows: [{}] };
      return { rows: [{}] };
    }),
  };
  return client;
};

const stubMaintenance = (over: Record<string, unknown> = {}) => ({
  listActiveDeployments: vi.fn(async () => [
    { id: "dep-baseline", status: "SUCCESS", meta: { commitHash: SHA, createdAt: "2026-09-01T00:00:00Z" } },
  ]),
  stopAndVerifyAll: vi.fn(async () => true),
  deployApp: vi.fn(async () => "dep-new"),
  readDeployment: vi.fn(async () => ({ status: "SUCCESS" })),
  tokenIdentity: vi.fn(async () => ({ environmentId: "env-staging" })),
  ...over,
});

const abortedSignal = (reason?: unknown) => {
  const controller = new AbortController();
  controller.abort(reason ?? Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" }));
  return controller.signal;
};

const run = (args: Record<string, unknown>) =>
  bootstrapRollback({ rollbackStore: {}, env: ENV, ...args }).then(() => null, (error: Error) => error);

afterEach(() => vi.unstubAllGlobals());

describe("L1 — a cancelled bootstrap never opens a maintenance window", () => {
  it("refuses a PRE-ABORTED fresh bootstrap before it reads the journal or measures anything", async () => {
    const client = fakeClient(freshJournal());
    const maintenance = stubMaintenance();

    const error = await run({ client, maintenance, signal: abortedSignal() });

    expect(error).toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(client.updates, "a cancelled bootstrap still moved the journal").toEqual([]);
    expect(maintenance.listActiveDeployments, "a cancelled bootstrap still measured the baseline").not.toHaveBeenCalled();
    expect(maintenance.stopAndVerifyAll).not.toHaveBeenCalled();
    expect(maintenance.deployApp, "a cancelled bootstrap redeployed the app it never stopped").not.toHaveBeenCalled();
  });

  it("refuses a PRE-ABORTED resume the same way", async () => {
    const client = fakeClient(resumeJournal());
    const maintenance = stubMaintenance();

    const error = await run({ client, maintenance, signal: abortedSignal() });

    expect(error).toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(client.updates).toEqual([]);
    expect(maintenance.stopAndVerifyAll).not.toHaveBeenCalled();
    expect(maintenance.deployApp).not.toHaveBeenCalled();
  });

  it("refuses a shutdown delivered AFTER the read-only measurement but BEFORE admission", async () => {
    // The window the fix is actually for. The deployment measurement is a read and completes; the
    // signal lands during it; the very next thing would have been `beginBootstrapDraining` and the
    // stop. Nothing may transition, stop or redeploy — and the failure must not fall through to the
    // baseline restart, which would mutate lifecycle state for an invocation that changed nothing.
    const controller = new AbortController();
    const client = fakeClient(freshJournal());
    const maintenance = stubMaintenance({
      listActiveDeployments: vi.fn(async () => {
        controller.abort(Object.assign(new Error("importer received SIGTERM"), { code: "STAGING_OPERATION_ABORTED" }));
        return [{ id: "dep-baseline", status: "SUCCESS", meta: { commitHash: SHA, createdAt: "2026-09-01T00:00:00Z" } }];
      }),
    });

    const error = await run({ client, maintenance, signal: controller.signal });

    expect(error).toMatchObject({ code: "STAGING_OPERATION_ABORTED" });
    expect(maintenance.listActiveDeployments, "the read-only measurement should still have happened").toHaveBeenCalled();
    expect(client.updates, "a pre-admission cancellation moved the journal").toEqual([]);
    expect(maintenance.stopAndVerifyAll).not.toHaveBeenCalled();
    expect(maintenance.deployApp, "an external shutdown was converted into a redeploy").not.toHaveBeenCalled();
  });
});

describe("L3 — a retry that was never admitted mutates nothing", () => {
  it("emits no deployment and no transition when the recorded mode differs from the configured one", async () => {
    // `current` used to be assigned from the record BEFORE this validation, and the catch restarts
    // whenever `current` exists — using the configured mode the validation had just rejected. So a
    // mismatched retry transitioned the journal to `booting` and deployed, having been admitted to
    // nothing.
    const client = fakeClient(resumeJournal({ bootstrap_mode: "copy-ready" }));
    const maintenance = stubMaintenance();

    const error = await run({ client, maintenance, signal: new AbortController().signal });

    expect(error?.message).toMatch(/different supported staging mode/);
    expect(client.updates, "a refused-mode retry wrote to the journal").toEqual([]);
    expect(maintenance.stopAndVerifyAll).not.toHaveBeenCalled();
    expect(maintenance.deployApp, "a refused-mode retry issued a deployment").not.toHaveBeenCalled();
    // …and it does not claim anything about the baseline it never touched.
    expect(error?.message).not.toMatch(/restored unchanged/);
  });

  it("still recovers a PARTIAL stop, restoring the recorded baseline with the RECORDED mode", async () => {
    // The other side of the boundary, and why admission is tracked rather than "the stop returned":
    // a stop that throws may already have stopped some services, so recovery is mandatory. Here the
    // resume is admitted, the stop fails mid-way, and the baseline must come back — at the commit
    // and in the mode the interruption record names, not at whatever a later measurement would find.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ booted: true, commit: SHA }, { status: 202 })));
    const client = fakeClient(resumeJournal());
    const maintenance = stubMaintenance({
      stopAndVerifyAll: vi.fn(async () => { throw new Error("graphiti stop could not be verified"); }),
    });

    const error = await run({ client, maintenance, signal: new AbortController().signal });

    expect(error?.message).toMatch(/prior staging deployment restored unchanged/);
    expect(maintenance.deployApp, "the partially stopped baseline was not restarted").toHaveBeenCalledWith(SHA);
    // The booting transition carries the RECORDED mode (parameter 7 of `transitionJournal`), and the
    // run identity is the recorded bootstrap's, not a fresh one.
    expect(client.updates.map((update) => update.params[1]), "the recovery sequence changed shape")
      .toEqual(["draining", "booting", "failed"]);
    const booting = client.updates.find((update) => update.params[1] === "booting");
    expect(booting?.params[0]).toBe("bootstrap-1");
    expect(booting?.params[6]).toBe("legacy-pg-only");
    // The interruption record is cleared in ONE place only — after ready commits — so a failed
    // recovery must leave it for the next run. `clearBootstrapRecovery` was never called.
    expect(client.updates.some((update) => /bootstrap_phase=NULL/.test(update.sql)), "the interruption record was cleared by a failed recovery").toBe(false);
  });
});
