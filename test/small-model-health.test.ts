import { describe, expect, it, vi, beforeEach } from "vitest";

const sql = vi.hoisted(() => ({ runSql: vi.fn() }));
vi.mock("@/lib/db/pg/pool", () => ({ runSql: sql.runSql }));

const { smallRoutingEvidence } = await import("@/lib/llm/small-model-health");

/**
 * AIO-983 — the evidence half. `describeSmallExtraction` answers "configured and resolvable", which
 * is NOT "working": with a resolvable backend and a drifted marker it reported healthy while zero
 * calls were routed. This reads the ledger for what actually happened.
 *
 * The discipline being pinned is the repo's, learned twice (AIO-876, AIO-912): an alarm must have
 * standing evidence, so "nothing to judge" must be a distinct answer from "not working" and must
 * never render as an accusation.
 */
/** Two reads now: the audit window (when the setting last changed), then the aggregate counts. */
const counts = (eligible: number, servedSmall: number) => ({ rows: [{ eligible, served_small: servedSmall }] });
const auditAt = (iso: string | null) => ({ rows: iso ? [{ created_at: iso }] : [] });
/** Default: no recorded change (whole window), then the given counts. */
function mockReads(eligible: number, servedSmall: number, since: string | null = null) {
  sql.runSql.mockResolvedValueOnce(auditAt(since)).mockResolvedValueOnce(counts(eligible, servedSmall));
}
const SMALL = "qwen/qwen3.7-flash";

beforeEach(() => sql.runSql.mockReset());

describe("smallRoutingEvidence", () => {
  it("REPORTS THE ABSENCE: eligible calls happened and none were served small", async () => {
    // The defect this slice exists for. Before it, this state was indistinguishable from healthy.
    mockReads(20, 0);
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "not_routing", eligible: 20 });
  });

  it("confirms routing when the ledger shows the small model actually served calls", async () => {
    mockReads(20, 12);
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "routing", servedSmall: 12, eligible: 20 });
  });

  it("says NOTHING TO JUDGE on a quiet team — a quiet team is not a broken one", async () => {
    mockReads(0, 0);
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "no_traffic" });
  });

  it("refuses to conclude from too few calls — the just-enabled window", async () => {
    // Right after someone enables the setting the recent rows are legitimately PRE-enable history,
    // and reading them as "not routing" would accuse the operator of a fault they just fixed. The
    // floor is what stops that, and it clears on VOLUME so it resolves as soon as real traffic runs.
    mockReads(4, 0);
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "inconclusive", eligible: 4 });
  });

  it("counts only SMALL-ELIGIBLE kinds, scoped to graph and to THIS team", async () => {
    // `call_kind` is three-valued: '' is pre-metering history and 'unknown' is prompt drift, and no
    // read may coalesce them into an eligible kind. And another team's traffic must never be
    // evidence about this team's per-team setting.
    mockReads(1, 1);
    await smallRoutingEvidence("team-42", SMALL);
    const [query, params] = sql.runSql.mock.calls[1];
    expect(query).toContain("source = 'graph'");
    expect(query).toContain("call_kind = any($2)");
    expect(query).toContain("team_id = $1");
    expect(params[0]).toBe("team-42");
    expect(params[1]).not.toContain("");
    expect(params[1]).not.toContain("unknown");
    expect(params[1]).toContain("dedupe_edges");
    // Counted in SQL — the money-ledger guard's rule, and two integers beat fifty rows.
    expect(query).toMatch(/count\(\*\)/);
  });

  it("takes the MOST RECENT calls, so pre-enable history ages out on volume", async () => {
    mockReads(1, 1);
    await smallRoutingEvidence("t1", SMALL);
    expect(sql.runSql.mock.calls[1][0]).toContain("order by created_at desc");
  });

  it("an unset small model reports NOT CONFIGURED, not 'no traffic'", async () => {
    // Review Medium 2: `no_traffic` renders as "no extraction has run recently" — a claim about
    // traffic this branch never looked at. The module must not say things it has not checked.
    expect(await smallRoutingEvidence("t1", "  ")).toEqual({ state: "not_configured" });
    expect(sql.runSql).not.toHaveBeenCalled();
  });

  it("does NOT accuse a busy team that just enabled the setting", async () => {
    // Review Medium 1, the false-alarm this module would otherwise produce: 50 eligible calls all
    // PREDATING the change, admin opens the page before the next extraction runs. A volume-only
    // window ages that out; it does not prevent it. Bounding below by the setting-change audit row
    // does — the post-change window is genuinely empty, so there is nothing to judge.
    mockReads(0, 0, "2026-08-19T12:00:00Z");
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "no_traffic" });
    const [, params] = sql.runSql.mock.calls[1];
    expect(params[4]).toBe("2026-08-19T12:00:00Z"); // the window floor is carried into the SQL
  });

  it("keeps the whole window when the setting has no recorded change", async () => {
    // A team whose setting predates the audit trail: those rows ARE post-enable, so narrowing
    // would hide real evidence. Null floor, and the SQL must treat null as 'no lower bound'.
    mockReads(20, 0, null);
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "not_routing", eligible: 20 });
    const [query, params] = sql.runSql.mock.calls[1];
    expect(params[4]).toBeNull();
    expect(query).toContain("$5::timestamptz is null");
  });

  it("a failed audit read keeps the full window rather than silently narrowing it", async () => {
    sql.runSql.mockRejectedValueOnce(new Error("audit boom")).mockResolvedValueOnce(counts(20, 0));
    expect(await smallRoutingEvidence("t1", SMALL)).toEqual({ state: "not_routing", eligible: 20 });
  });
});
