import { describe, expect, it, vi } from "vitest";
import { injectAbortedTransactionFault, sqlAbortFaultArmed } from "../scripts/staging-ops/importer.mjs";
import { parseReceipts } from "../scripts/staging-ops/receipts.mjs";

/**
 * The gap this seam closes (see `full-importer-sql-abort-adjudication.md`): the existing
 * `after-postgres` / `after-graph` faults are plain JavaScript `throw`s, so the importer's
 * lock-owning Postgres session is still perfectly usable when recovery begins. They can pin the
 * ORDER in which `resetSessionTransactionState` is called; they can never show it doing anything,
 * because there is no aborted transaction to end.
 *
 * These are the seam's own contract tests. They are NOT the proof — that is owed to the paired
 * Docker harness (`sql-abort-recovers`), which runs a real Postgres, a real 22012 and the real
 * two-store recovery. What they pin is the part a runtime run cannot re-check cheaply: the double
 * fence, and that nothing here quietly rescues the session before the caller sees it.
 */

type Query = { sql: string; params?: unknown[] };

function fakeClient({ divideByZero = { code: "22012" } as Record<string, unknown> | null, pid = 4242, newest = 4 } = {}) {
  const statements: Query[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("pg_backend_pid")) return { rows: [{ pid }] };
    if (sql.includes("FROM items")) return { rows: [{ n: newest }] };
    if (sql === "SELECT 1/0") {
      if (!divideByZero) return { rows: [{ "?column?": 0 }] };
      throw Object.assign(new Error("division by zero"), divideByZero);
    }
    return { rows: [] };
  });
  return { query, statements };
}

const fakeSession = (versions: string[] = ["v4"]) => ({
  run: vi.fn(async () => ({ records: versions.map((version) => ({ get: () => version })) })),
});

const OPENED = { manifest: { runId: "run-4", kind: "staging-pair" } };

/** Receipts are one line of stdout each; capturing them is how the harness reads them too. */
async function captureReceipts(run: () => Promise<unknown>) {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  try {
    const outcome = await run().then(() => null, (error: unknown) => error);
    return { outcome, receipts: parseReceipts(lines.join("\n")) };
  } finally {
    log.mockRestore();
  }
}

describe("the SQL-abort fault is fenced by BOTH the harness flag and the local adapter", () => {
  const armed = {
    STAGING_PAIR_REQUIRED: "1",
    STAGING_MAINTENANCE_ADAPTER: "local",
    STAGING_FAULT_POINT: "after-graph-sql-abort",
  };

  it("arms only for the exact harness/local/fault-point combination", () => {
    expect(sqlAbortFaultArmed(armed)).toBe(true);
  });

  it("stays disarmed on the RAILWAY adapter even with the fault variable present", () => {
    // The one case the adjudication names: a fault variable that leaks onto a real staging importer
    // must not be able to abort a transaction against a live database.
    expect(sqlAbortFaultArmed({ ...armed, STAGING_MAINTENANCE_ADAPTER: "railway" })).toBe(false);
    expect(sqlAbortFaultArmed({ ...armed, STAGING_MAINTENANCE_ADAPTER: undefined })).toBe(false);
  });

  it("stays disarmed outside the required harness mode, and for every other fault point", () => {
    expect(sqlAbortFaultArmed({ ...armed, STAGING_PAIR_REQUIRED: undefined })).toBe(false);
    expect(sqlAbortFaultArmed({ ...armed, STAGING_PAIR_REQUIRED: "0" })).toBe(false);
    for (const point of ["before-drain", "after-postgres", "after-graph", undefined]) {
      expect(sqlAbortFaultArmed({ ...armed, STAGING_FAULT_POINT: point }), String(point)).toBe(false);
    }
  });
});

describe("injectAbortedTransactionFault", () => {
  it("leaves the transaction ABORTED and hands the caller the database's own error", async () => {
    const client = fakeClient();
    const session = fakeSession();
    const { outcome, receipts } = await captureReceipts(() => injectAbortedTransactionFault({ client, session, opened: OPENED }));

    // The real pg error object, not a stand-in: the recovery path branches on it being a database
    // failure, and a wrapped `new Error` would exercise the JavaScript-throw case all over again.
    expect((outcome as { code?: string })?.code).toBe("22012");
    const sql = client.statements.map(({ sql: text }) => text);
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("SELECT 1/0");
    expect(sql.indexOf("BEGIN")).toBeLessThan(sql.indexOf("SELECT 1/0"));
    // THE POINT OF THE WHOLE SEAM. Any of these would hand the recovery path a healthy session and
    // the scenario would prove exactly what the JavaScript faults already proved.
    expect(sql).not.toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(sql.some((text) => text.includes("DISCARD"))).toBe(false);
    expect(receipts.at(-1)?.kind).toBe("fault-injected");
  });

  it("records the candidate in BOTH stores BEFORE the failing statement", async () => {
    const client = fakeClient();
    const session = fakeSession();
    const { receipts } = await captureReceipts(() => injectAbortedTransactionFault({ client, session, opened: OPENED }));

    const candidate = receipts.find((receipt) => receipt.kind === "candidate-observed");
    expect(candidate?.fields).toMatchObject({ runId: "run-4", backendPid: 4242, pgVersion: "v4", graphVersions: "v4" });
    // Both stores are READ, on the session that is about to be aborted, while it can still answer:
    // after the abort every one of these would fail with 25P02, so the observation has to precede
    // the transaction. Stated as index inequalities, not as "a query happened".
    const sql = client.statements.map(({ sql: text }) => text);
    const pgRead = sql.findIndex((text) => text.includes("FROM items"));
    expect(pgRead).toBeGreaterThan(-1);
    expect(session.run).toHaveBeenCalledWith(expect.stringContaining("RELATES_TO"));
    expect(pgRead).toBeLessThan(sql.indexOf("BEGIN"));
    // …and it is the FIRST receipt, so a scenario satisfied by some earlier refusal cannot produce
    // it at all.
    expect(receipts.indexOf(candidate!)).toBe(0);

    const fault = receipts.find((receipt) => receipt.kind === "fault-injected");
    expect(fault?.fields).toMatchObject({
      point: "after-graph-sql-abort", runId: "run-4", postgresRestored: true,
      graphRestored: true, sqlstate: "22012", backendPid: 4242, transactionAborted: true,
    });
  });

  it("reports what the STORES say, not a constant the receipt could carry either way", async () => {
    // Without this the whole candidate receipt could be hardcoded and every harness assertion about
    // "both stores held v4" would still pass. Different store contents must produce a different
    // receipt.
    const { receipts } = await captureReceipts(() => injectAbortedTransactionFault({
      client: fakeClient({ newest: 3, pid: 99 }), session: fakeSession(["v3"]), opened: OPENED,
    }));
    expect(receipts[0]?.fields).toMatchObject({ backendPid: 99, pgVersion: "v3", graphVersions: "v3" });
  });

  it("reports a PARTIALLY replaced graph rather than averaging it away", async () => {
    // A graph carrying two capture versions is a real defect; the receipt must show both so the
    // harness pattern (`"graphVersions":"v4"`) refuses instead of matching a substring of a set.
    const { receipts } = await captureReceipts(() =>
      injectAbortedTransactionFault({ client: fakeClient(), session: fakeSession(["v3", "v4"]), opened: OPENED }));
    expect(receipts[0]?.fields.graphVersions).toBe("v3,v4");
  });

  it("refuses when the failing statement did not produce the database error it claims", async () => {
    // Negative control for the assertion above: without it, a client that threw a connection error
    // (leaving no aborted transaction at all) would emit a receipt saying 22012.
    const { outcome, receipts } = await captureReceipts(() => injectAbortedTransactionFault({
      client: fakeClient({ divideByZero: { code: "57P01" } }), session: fakeSession(), opened: OPENED,
    }));
    expect((outcome as Error).message).toMatch(/expected SQLSTATE 22012 from the database, observed 57P01/);
    expect(receipts.some((receipt) => receipt.kind === "fault-injected")).toBe(false);
  });

  it("refuses when the abort does not abort", async () => {
    const { outcome, receipts } = await captureReceipts(() => injectAbortedTransactionFault({
      client: fakeClient({ divideByZero: null }), session: fakeSession(), opened: OPENED,
    }));
    expect((outcome as Error).message).toMatch(/whose transaction never aborts proves nothing/);
    expect(receipts.some((receipt) => receipt.kind === "fault-injected")).toBe(false);
  });
});
