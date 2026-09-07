import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDITFIX-14 — the shared manual context pass (`lib/ingest/manual-context.ts`), unit tier.
 *
 * Spec-derived, from `docs/design/auditfix14-manual-context-reconcile.md` §"Decision" and
 * §"Outcomes, diagnostics and recovery". What this file owns:
 *
 *   • the SELECTION contract — exactly one `backfillTeamContext` call, batch 25, null start, and
 *     NO `createdBefore`. The cutoff is omitted deliberately: `ingestItem` stamps `items.created_at`
 *     from the APPLICATION clock, so a Postgres-clock cutoff could exclude a just-imported item
 *     under skew. A test that only checked "was it called" would stay green through a 500-batch
 *     drain, which is the mutation AC14-08 aims at;
 *   • the three OUTCOMES and their honesty rules. `ok:true` + null cursor is a complete pass over
 *     the ELIGIBLE CANDIDATES, never "all items are visible"; a non-null cursor means more may
 *     remain; a returned failure or a throw is reported as a failure with the counts that are
 *     actually known — a throw has UNKNOWN progress (null), not an asserted zero;
 *   • the ledger row, whose `ok`/`errors`/`meta.status` split is what keeps routine bounded pending
 *     work out of `pipeline-health`'s failure streak;
 *   • `adminSyncResult`, the composition the four admin actions share. Both admin consumers render
 *     only `error` on a failed result and IGNORE `message` on a successful one, so pending work
 *     that shipped as `{ok:true, message}` would be invisible.
 *
 * The helper is stubbed at `backfillTeamContext`/`recordIngestRun` here on purpose: the real-DB
 * outcome (a membership that makes an item readable) is proven in
 * `test/datamechanics/manual-context-reconcile.datamechanics.test.ts`, not by a call-shape assertion.
 */

const h = vi.hoisted(() => ({
  backfillTeamContext: vi.fn(),
  recordIngestRun: vi.fn(),
  adminDb: { __marker: "admin-db" },
}));

vi.mock("@/lib/projects/context/backfill", () => ({ backfillTeamContext: h.backfillTeamContext }));
vi.mock("@/lib/ingest/runs", () => ({ recordIngestRun: h.recordIngestRun }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => h.adminDb }));

import {
  MANUAL_CONTEXT_BATCH,
  adminSyncResult,
  runManualContextPass,
} from "@/lib/ingest/manual-context";

const complete = { ok: true, scanned: 3, unitsCreated: 2, membershipsCreated: 2, spared: 0, cursor: null };
const pending = { ok: true, scanned: 25, unitsCreated: 25, membershipsCreated: 25, spared: 0, cursor: "item-25" };
const returnedFailure = {
  ok: false,
  error: "item-7: reconcile refused",
  scanned: 6,
  unitsCreated: 6,
  membershipsCreated: 6,
  spared: 0,
  cursor: "item-6",
};

/** No message may promise total visibility — excluded/retracted content is outside every pass. */
const TOTAL_VISIBILITY = /\b(all|every|everything)\b[^.]{0,40}\bvisible\b/i;

beforeEach(() => {
  h.backfillTeamContext.mockReset().mockResolvedValue(complete);
  h.recordIngestRun.mockReset().mockResolvedValue(undefined);
});

describe("runManualContextPass — one bounded, candidate-only pass", () => {
  it("calls backfillTeamContext EXACTLY once, batch 25, from null, with NO cutoff", async () => {
    await runManualContextPass("team-1", "manual_sync");

    expect(h.backfillTeamContext).toHaveBeenCalledTimes(1);
    const [dbArg, teamArg, opts] = h.backfillTeamContext.mock.calls[0];
    expect(dbArg).toBe(h.adminDb);
    expect(teamArg).toBe("team-1");
    // Equality, not `toMatchObject`: a 500-default or an unbounded drain must redden here.
    expect(opts).toEqual({ batchSize: 25, afterId: null });
    // `createdBefore` is omitted by DESIGN (application-clock `created_at` vs a Postgres cutoff);
    // asserting its ABSENCE is what makes re-adding one a red test rather than a silent narrowing.
    expect(Object.keys(opts)).not.toContain("createdBefore");
    expect(MANUAL_CONTEXT_BATCH).toBe(25);
  });

  it("never consumes or writes a stored manual cursor — a second pass also starts at null", async () => {
    h.backfillTeamContext.mockResolvedValue(pending);
    await runManualContextPass("team-1", "manual_sync");
    await runManualContextPass("team-1", "manual_sync");
    for (const call of h.backfillTeamContext.mock.calls) expect(call[2].afterId).toBeNull();
  });

  it("COMPLETE: reports the eligible candidate pass and its counts — never total visibility", async () => {
    const out = await runManualContextPass("team-1", "manual_sync");

    expect(out.status).toBe("complete");
    expect(out.scanned).toBe(3);
    expect(out.unitsCreated).toBe(2);
    expect(out.membershipsCreated).toBe(2);
    expect(out.cursor).toBeNull();
    expect(out.error).toBeNull();
    expect(out.message).toMatch(/project context/i);
    expect(out.message).toContain("3");
    expect(out.message).toContain("2");
    expect(out.message, "a complete pass covers eligible candidates, not the whole corpus").not.toMatch(
      TOTAL_VISIBILITY
    );
  });

  it("PENDING: the 25-candidate limit is reported as work that may remain, with retry guidance", async () => {
    h.backfillTeamContext.mockResolvedValue(pending);

    const out = await runManualContextPass("team-1", "manual_sync");

    expect(out.status).toBe("pending");
    expect(out.cursor).toBe("item-25");
    expect(out.message).toMatch(/more project-context work may remain/i);
    expect(out.message, "the caller must be told to run it again").toMatch(/run sync again/i);
    expect(out.message, "some imported content may not be readable yet").toMatch(/may not.*readable/i);
    expect(out.message).not.toMatch(TOTAL_VISIBILITY);
    // The scheduler is mentioned CONDITIONALLY, never as a promise — a disabled poller is the
    // principal reason this fix exists.
    expect(out.message).toMatch(/scheduler[^.]*when enabled/i);
    expect(out.message, "a conditional mention, not a guarantee").not.toMatch(/the scheduler will/i);
  });

  it("RETURNED FAILURE: keeps the counts that ARE known and says the import was kept", async () => {
    h.backfillTeamContext.mockResolvedValue(returnedFailure);

    const out = await runManualContextPass("team-1", "manual_sync");

    expect(out.status).toBe("failed");
    expect(out.error).toBe("item-7: reconcile refused");
    expect(out.scanned).toBe(6);
    expect(out.membershipsCreated).toBe(6);
    expect(out.message).toMatch(/imported data was kept/i);
    expect(out.message).toContain("item-7: reconcile refused");
    expect(out.message).toMatch(/may not.*readable/i);
    expect(out.message).toMatch(/run sync again/i);
  });

  it("THROWN FAILURE: progress is UNKNOWN (null), never a fabricated zero", async () => {
    h.backfillTeamContext.mockRejectedValue(new Error("connection terminated"));

    const out = await runManualContextPass("team-1", "manual_sync");

    expect(out.status).toBe("failed");
    expect(out.error).toContain("connection terminated");
    // The distinction the spec insists on: a throw is not proof that nothing was written.
    expect(out.scanned).toBeNull();
    expect(out.unitsCreated).toBeNull();
    expect(out.membershipsCreated).toBeNull();
    expect(out.message).toMatch(/imported data was kept/i);
  });

  it("a non-Error throw still yields a usable diagnostic rather than [object Object]", async () => {
    h.backfillTeamContext.mockRejectedValue("pool closed");
    const out = await runManualContextPass("team-1", "manual_sync");
    expect(out.status).toBe("failed");
    expect(out.error).toBeTruthy();
    expect(out.message).not.toContain("[object Object]");
  });
});

describe("runManualContextPass — the ingest_runs row (AC14-07)", () => {
  it("COMPLETE records ok:true, empty errors, and the entrypoint + counts in meta", async () => {
    await runManualContextPass("team-1", "slack");

    expect(h.recordIngestRun).toHaveBeenCalledTimes(1);
    const [dbArg, run] = h.recordIngestRun.mock.calls[0];
    expect(dbArg).toBe(h.adminDb);
    expect(run.teamId).toBe("team-1");
    expect(run.source).toBe("context_backfill");
    // The literal, NOT a constant: `test/guards/ingest-leg-ledger` cannot resolve a trigger constant.
    expect(run.trigger).toBe("manual");
    expect(run.ok).toBe(true);
    expect(run.errors ?? []).toEqual([]);
    expect(run.created, "`created` is memberships created").toBe(2);
    expect(run.meta).toMatchObject({
      entrypoint: "slack",
      status: "complete",
      scanned: 3,
      unitsCreated: 2,
      membershipsCreated: 2,
      cursor: null,
    });
    expect(typeof run.startedAt).toBe("number");
  });

  it("PENDING records ok:true with empty errors — routine bounded work is NOT an outage", async () => {
    h.backfillTeamContext.mockResolvedValue(pending);

    await runManualContextPass("team-1", "github");

    const run = h.recordIngestRun.mock.calls[0][1];
    expect(run.ok, "a bounded pass SUCCEEDED; the backlog lives in meta.status").toBe(true);
    expect(run.errors ?? []).toEqual([]);
    expect(run.meta).toMatchObject({ entrypoint: "github", status: "pending", cursor: "item-25" });
  });

  it("FAILED records ok:false with the diagnostic", async () => {
    h.backfillTeamContext.mockResolvedValue(returnedFailure);

    await runManualContextPass("team-1", "plane");

    const run = h.recordIngestRun.mock.calls[0][1];
    expect(run.ok).toBe(false);
    expect(run.errors).toEqual(["item-7: reconcile refused"]);
    expect(run.meta).toMatchObject({ entrypoint: "plane", status: "failed" });
  });

  it("a THROWN pass records null counts in meta — unknown progress is not a measurement", async () => {
    h.backfillTeamContext.mockRejectedValue(new Error("boom"));

    await runManualContextPass("team-1", "linear");

    const run = h.recordIngestRun.mock.calls[0][1];
    expect(run.ok).toBe(false);
    expect(run.meta).toMatchObject({
      entrypoint: "linear",
      status: "failed",
      scanned: null,
      unitsCreated: null,
      membershipsCreated: null,
    });
    expect(run.created, "nothing is known to have been created").toBe(0);
  });

  it("`startedAt` is the CONTEXT stage start, so the duration excludes the provider imports", async () => {
    const before = Date.now();
    h.backfillTeamContext.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return complete;
    });
    await runManualContextPass("team-1", "manual_sync");
    const run = h.recordIngestRun.mock.calls[0][1];
    expect(run.startedAt).toBeGreaterThanOrEqual(before);
    expect(run.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("a FAILED ledger write never removes the caller's message", async () => {
    h.recordIngestRun.mockRejectedValue(new Error("ledger down"));

    const out = await runManualContextPass("team-1", "manual_sync");

    expect(out.status).toBe("complete");
    expect(out.message).toMatch(/project context/i);
  });

  it("every entrypoint reaches meta verbatim — `manual_sync` covers both the dashboard and the CLI", async () => {
    for (const entry of ["manual_sync", "slack", "plane", "linear", "github"] as const) {
      h.recordIngestRun.mockClear();
      await runManualContextPass("team-1", entry);
      expect(h.recordIngestRun.mock.calls[0][1].meta.entrypoint).toBe(entry);
    }
  });
});

describe("adminSyncResult — the shape both admin consumers actually render", () => {
  const ctx = (status: "complete" | "pending" | "failed") => ({
    status,
    scanned: status === "failed" ? null : 3,
    unitsCreated: status === "failed" ? null : 2,
    membershipsCreated: status === "failed" ? null : 2,
    cursor: status === "pending" ? "item-25" : null,
    error: status === "failed" ? "reconcile refused" : null,
    message: `CTX-${status}`,
  });

  it("ok:true ONLY when the provider pass was clean AND the context pass completed", () => {
    const r = adminSyncResult({
      importOk: true,
      importError: null,
      importMessage: "Synced 2 channel(s): +1 new.",
      context: ctx("complete"),
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Synced 2 channel(s): +1 new.");
    expect(r.message).toContain("CTX-complete");
    expect(r.error).toBeUndefined();
  });

  it("a clean import with PENDING context is ok:FALSE and leads with 'Import succeeded'", () => {
    const r = adminSyncResult({
      importOk: true,
      importError: null,
      importMessage: "Imported 4 issue(s).",
      context: ctx("pending"),
    });
    // The GitHub panel ignores `message` on a successful result, so `{ok:true, message}` would
    // hide the remaining work entirely.
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/import succeeded/i);
    expect(r.error).toContain("Imported 4 issue(s).");
    expect(r.error).toContain("CTX-pending");
  });

  it("a provider error keeps BOTH diagnostics — neither overwrites the other", () => {
    const r = adminSyncResult({
      importOk: false,
      importError: "channel C1 is private",
      importMessage: null,
      context: ctx("complete"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("channel C1 is private");
    expect(r.error).toContain("CTX-complete");
    expect(r.error, "a failed import must never read as a success").not.toMatch(/import succeeded/i);
  });

  it("a failed context alongside a clean import keeps both, and stays ok:false", () => {
    const r = adminSyncResult({
      importOk: true,
      importError: null,
      importMessage: "Imported 4 issue(s).",
      context: ctx("failed"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Imported 4 issue(s).");
    expect(r.error).toContain("CTX-failed");
  });

  it("a SKIPPED import says skipped/busy and never claims an import succeeded", () => {
    const r = adminSyncResult({
      importOk: false,
      importError: "Import skipped — another sync is already running; try again in a moment.",
      importMessage: null,
      context: ctx("complete"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/skipped/i);
    expect(r.error).not.toMatch(/import succeeded/i);
    expect(r.error).toContain("CTX-complete");
  });
});
