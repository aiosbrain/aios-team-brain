import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rollbackToPrior } from "../scripts/staging-ops/importer.mjs";
import { resetSessionTransactionState } from "../scripts/staging-ops/pg-paired.mjs";

/**
 * The measured failure this file pins (PG18, `pg-diagnostic-42b701e2/probe.log`):
 *
 * a loader migration that fails INSIDE a transaction leaves the importer's connection in Postgres'
 * aborted state, and every statement on it then fails with `25P02` until the transaction ends. The
 * recovery path ran journal, advisory-lock and marker SQL on exactly that connection — the journal
 * writes were wrapped in `.catch(() => {})`, so they failed invisibly, and the caller went on to
 * report that "the prior pair was restored".
 *
 * Two properties, both of which have to hold: the reset happens BEFORE the first recovery
 * statement, and a session that cannot be reset produces a refusal instead of a false success.
 */

/** A pg double that behaves like a connection left mid-aborted-transaction. */
function abortedClient({ rollbackWorks = true } = {}) {
  let aborted = true;
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(String(sql));
    if (String(sql) === "ROLLBACK") {
      if (!rollbackWorks) throw new Error("Connection terminated unexpectedly");
      aborted = false;
      return { rows: [] };
    }
    if (aborted) {
      throw Object.assign(new Error("current transaction is aborted, commands ignored until end of transaction block"), { code: "25P02" });
    }
    if (String(sql).startsWith("UPDATE staging_ops.refresh_journal")) return { rows: [{ state: "draining" }] };
    if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    return { rows: [] };
  });
  return { query, statements, on: vi.fn() };
}

const PRIOR = {
  kind: "rollback" as const,
  objectId: "prior--" + "a".repeat(64),
  digest: "a".repeat(64),
  sourceBytes: Buffer.from("prior"),
  manifest: { runId: "prior-run", targetCommit: "b".repeat(40), mode: "copy-ready" },
};

function fakes() {
  return {
    maintenance: { stopAndVerifyAll: vi.fn(async () => true) },
    rollbackStore: { putImmutable: vi.fn(async () => true), verify: vi.fn(async () => true), writePointer: vi.fn(async () => true) },
    env: {
      NEO4J_URL: "bolt://127.0.0.1:7687", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "FAKE-unused-in-this-test",
      NEO4J_DATABASE: "neo4j", STAGING_DATA_LOCK_TIMEOUT_MS: "1000",
      // The injected harness fault stops the path immediately after the lock is reacquired, so the
      // test observes the ORDERING without needing a real Postgres or a real graph.
      STAGING_PAIR_REQUIRED: "1", STAGING_FAULT_ROLLBACK: "1",
    } as unknown as NodeJS.ProcessEnv,
  };
}

describe("resetSessionTransactionState", () => {
  it("ends the transaction with ROLLBACK alone — never DISCARD ALL, never a reconnect", async () => {
    const client = abortedClient();
    expect(await resetSessionTransactionState(client)).toEqual({ status: "reset" });
    expect(client.statements).toEqual(["ROLLBACK"]);
  });

  it("reports the failure instead of throwing, because the caller's decision depends on it", async () => {
    const client = abortedClient({ rollbackWorks: false });
    const verdict = await resetSessionTransactionState(client);
    expect(verdict.status).toBe("reset-failed");
    expect(verdict.detail).toContain("Connection terminated");
  });
});

describe("the importer's recovery path on an aborted connection", () => {
  it("installs a distinct finite recovery budget on the same lock-owning session", async () => {
    const client = abortedClient();
    const { maintenance, rollbackStore, env } = fakes();
    const deadlines = { operationMs: 1_000, captureMs: 1_000, recoveryMs: 12_000, cleanupMs: 2_000, connectionMs: 1_000, terminateGraceMs: 100 };
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "failed-run", maintenance, rollbackStore, env, deadlines }))
      .rejects.toThrow(/injected harness rollback failure/);
    const configured = client.query.mock.calls.find(([sql]) => String(sql).includes("set_config('statement_timeout'"));
    const configuredMs = Number(String(configured?.[1]?.[0]).replace("ms", ""));
    expect(configuredMs).toBeGreaterThan(0);
    expect(configuredMs).toBeLessThanOrEqual(12_000);
    expect(configured?.[1]?.[1]).toBe(`${configuredMs}ms`);
    expect(client.statements.indexOf("ROLLBACK")).toBeLessThan(
      client.statements.findIndex((sql) => sql.includes("set_config('statement_timeout'")),
    );
  });

  it("resets BEFORE any journal or advisory-lock statement", async () => {
    const client = abortedClient();
    const { maintenance, rollbackStore, env } = fakes();
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "failed-run", maintenance, rollbackStore, env }))
      .rejects.toThrow(/injected harness rollback failure/);

    // The ordering assertion, stated as an inequality rather than "a ROLLBACK appears somewhere":
    // every journal/lock statement must come after the first reset.
    expect(client.statements[0]).toBe("ROLLBACK");
    const firstReset = client.statements.indexOf("ROLLBACK");
    const recoverySql = client.statements
      .map((sql, index) => ({ sql, index }))
      .filter(({ sql }) => sql.includes("refresh_journal") || sql.includes("advisory"));
    expect(recoverySql.length).toBeGreaterThan(0);
    for (const { index } of recoverySql) expect(index).toBeGreaterThan(firstReset);
    expect(client.statements).not.toContain("DISCARD ALL");
    expect(client.statements.some((sql) => sql.includes("pg_advisory_unlock_all"))).toBe(false);
  });

  it("records the recovery-required checkpoint, which the un-reset session could never have written", async () => {
    const client = abortedClient();
    const { maintenance, rollbackStore, env } = fakes();
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "failed-run", maintenance, rollbackStore, env }))
      .rejects.toThrow(/staging remains fenced and recovery is required/);
    const checkpoints = client.query.mock.calls
      .filter(([sql]) => String(sql).startsWith("UPDATE staging_ops.refresh_journal"))
      .map(([, params]) => (params as unknown[])[2]);
    expect(checkpoints).toContain("recovery-required");
  });

  it("attempts NO rollback, and claims none, when the session cannot be reset", async () => {
    const client = abortedClient({ rollbackWorks: false });
    const { maintenance, rollbackStore, env } = fakes();
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "failed-run", maintenance, rollbackStore, env }))
      .rejects.toThrow(/NO rollback was attempted/);
    // The services are NOT stopped: stopping staging through a session that cannot then restore it
    // converts a recoverable failure into an outage.
    expect(maintenance.stopAndVerifyAll).not.toHaveBeenCalled();
    expect(rollbackStore.writePointer).not.toHaveBeenCalled();
  });

  it("surfaces the reset failure in the message rather than swallowing it", async () => {
    const client = abortedClient({ rollbackWorks: false });
    const { maintenance, rollbackStore, env } = fakes();
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "failed-run", maintenance, rollbackStore, env }))
      .rejects.toThrow(/recovery notes:.*session reset failed/s);
  });

  it("aborts before lifecycle mutation when ready-to-draining admission is refused", async () => {
    const client = abortedClient();
    client.query.mockImplementation(async (sql: string) => {
      client.statements.push(String(sql));
      if (String(sql) === "ROLLBACK") return { rows: [] };
      if (String(sql).startsWith("UPDATE staging_ops.refresh_journal")) return { rows: [] };
      return { rows: [] };
    });
    const { maintenance, rollbackStore, env } = fakes();
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "manual-ready", maintenance, rollbackStore, env }))
      .rejects.toThrow(/journal transition to draining refused/);
    expect(maintenance.stopAndVerifyAll).not.toHaveBeenCalled();
  });

  it("admits a deliberate rollback from ready before stopping and retains the intended target on failure", async () => {
    const client = abortedClient();
    const { maintenance, rollbackStore, env } = fakes();
    await expect(rollbackToPrior({ client, prior: PRIOR, failedRunId: "manual-ready", maintenance, rollbackStore, env }))
      .rejects.toThrow(/recovery is required/);
    const drain = client.query.mock.calls.find(([sql, params]) =>
      String(sql).startsWith("UPDATE staging_ops.refresh_journal") && (params as unknown[])?.[1] === "draining",
    );
    expect((drain?.[1] as unknown[])?.at(-1)).toContain("ready");
    expect(maintenance.stopAndVerifyAll).toHaveBeenCalledTimes(1);
    expect(PRIOR).toMatchObject({ objectId: expect.stringContaining("prior--"), manifest: { runId: "prior-run" } });
  });
});

/**
 * `installObject`'s catch is the OTHER caller with the same ordering obligation, and it cannot be
 * driven from the unit tier: reaching it needs a signed bundle, the coordinator lock, a live
 * staging head read and a real two-store install. This is therefore a SUPPLEMENT — it pins the
 * ordering in the source, and the runtime proof is owed to the paired harness. It is written as an
 * ordering inequality, not as "the call appears somewhere", because appearing after the journal
 * write is exactly the defect.
 */
describe("installObject's failure path (structural supplement — not a runtime proof)", () => {
  const source = readFileSync(path.join(__dirname, "..", "scripts", "staging-ops", "importer.mjs"), "utf8");
  const installStart = source.indexOf("export async function installObject(");
  const installEnd = source.indexOf("\nasync function currentDeployment(", installStart);
  const installBody = source.slice(installStart, installEnd);
  const catchStart = installBody.indexOf("  } catch (error) {");
  const catchEnd = installBody.indexOf("  } finally { await releaseLock(client)", catchStart);
  const catchBlock = installBody.slice(catchStart, catchEnd);

  it("has a body to read at all", () => {
    // Positive extraction controls: source reshaping must fail by name, rather than leaving a
    // stale/empty slice whose downstream ordering checks no longer observe installObject at all.
    expect(installStart).toBeGreaterThan(-1);
    expect(installEnd).toBeGreaterThan(installStart);
    expect(catchStart).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(catchStart);
    expect(installBody).toContain("export async function installObject");
    expect(catchBlock.length).toBeGreaterThan(200);
    expect(catchBlock).toContain("if (!destructive)");
  });

  it("resets the session before the journal transition, the lock release and the rollback", () => {
    const reset = catchBlock.indexOf("resetSessionTransactionState(client)");
    expect(reset).toBeGreaterThan(-1);
    // `await rollback({`, not `rollbackToPrior({`: this call goes through `installObject`'s
    // injection seam (which DEFAULTS to `rollbackToPrior`), the same seam the interrupted-recovery
    // branch already used. Spelled as the call site actually reads, so a rename cannot leave this
    // ordering check matching nothing — `indexOf` returning -1 would fail here, which is the
    // intended behaviour, but the assertion message would be about ordering rather than absence.
    for (const later of ["transitionJournal(client", "releaseDataUseLock(client", "await rollback({"]) {
      expect(catchBlock.indexOf(later), `${later} is not in installObject's catch block`).toBeGreaterThan(reset);
    }
  });

  it("does not reach the rollback, or the sentence claiming one, when the session is unusable", () => {
    const guard = catchBlock.indexOf("if (!usable)");
    expect(guard).toBeGreaterThan(-1);
    expect(catchBlock.indexOf("the prior pair was NOT restored")).toBeGreaterThan(guard);
    // The success sentence must sit AFTER the refusal's `throw`, so it is unreachable without a
    // usable session.
    expect(catchBlock.indexOf("the prior pair was restored:")).toBeGreaterThan(catchBlock.indexOf("the prior pair was NOT restored"));
  });
});
