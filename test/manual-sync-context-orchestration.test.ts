import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDITFIX-14 — chat `/sync` orchestration (`lib/ingest/manual-sync.ts:runManualSync`), unit tier.
 *
 * Spec-derived from `docs/design/auditfix14-manual-context-reconcile.md`:
 *
 *   • AC14-02 SEQUENCING. The four runners settle independently and the optional Linear inbound
 *     stage runs after the Linear leg. The context pass happens ONCE, after ALL of them have
 *     settled — moving it earlier (or into the `Promise.all`) must redden here.
 *   • AC14-04 PARTIAL/THROW/BUSY. A returned error, a throw, a zero-integration error-only result,
 *     a `skipped:true` single-flight refusal and an inbound throw must each still reconcile, and
 *     must each keep their ORIGINAL diagnostic and source label. `safe()` currently turns a throw
 *     into `null`, which the summary reads as "unconfigured" — so a thrown Slack import vanishes
 *     from the text entirely, and a successful context line placed next to that silence would
 *     read as a clean run.
 *   • The summary contract: one **Project context** line; a pending/failed context outcome counts
 *     as ONE issue in `errors` and the headline stops saying an unconditional "Scrape complete";
 *     provider `created`/`updated` are NOT inflated by reconciliation counts.
 *
 * `runManualContextPass` is stubbed here — this file is about ORCHESTRATION. Its own contract is
 * `test/manual-context-pass.test.ts`; the observable DB outcome is the data-mechanics file.
 */

const h = vi.hoisted(() => ({
  runSlack: vi.fn(),
  runPlane: vi.fn(),
  runLinear: vi.fn(),
  runGithub: vi.fn(),
  runLinearInbound: vi.fn(),
  recordIngestRun: vi.fn(),
  runManualContextPass: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/ingest/run", () => ({
  runSlackIngestion: h.runSlack,
  runPlaneIngestion: h.runPlane,
  runLinearIngestion: h.runLinear,
  runGithubIngestion: h.runGithub,
}));
vi.mock("@/lib/pm-sync/inbound", () => ({ runLinearInbound: h.runLinearInbound }));
vi.mock("@/lib/ingest/runs", () => ({ recordIngestRun: h.recordIngestRun }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ __marker: "admin-db" }) }));
vi.mock("@/lib/ingest/manual-context", () => ({
  runManualContextPass: h.runManualContextPass,
}));

import { runManualSync } from "@/lib/ingest/manual-sync";

type Counts = {
  ok: boolean;
  integrations: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: string[];
  skipped?: boolean;
  channels?: number;
  projects?: number;
  items?: number;
};

const clean = (over: Partial<Counts> = {}): Counts => ({
  ok: true,
  integrations: 1,
  created: 0,
  updated: 0,
  unchanged: 0,
  errors: [],
  channels: 1,
  projects: 1,
  items: 0,
  ...over,
});

const unconfigured = (): Counts => ({
  ok: true,
  integrations: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  errors: [],
});

const contextOutcome = (
  status: "complete" | "pending" | "failed",
  message = `CTX-${status}`
) => ({
  status,
  scanned: status === "failed" ? null : 4,
  unitsCreated: status === "failed" ? null : 4,
  membershipsCreated: status === "failed" ? null : 4,
  cursor: status === "pending" ? "item-25" : null,
  error: status === "failed" ? "reconcile refused" : null,
  message,
});

/** A promise plus its resolvers, so a runner's settle order is chosen by the test. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((res) => {
    open = res;
  });
  return { promise, open };
}

/** Let queued microtasks (and the `Promise.all` continuations) run. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  h.order.length = 0;
  h.runSlack.mockReset().mockResolvedValue(clean());
  h.runPlane.mockReset().mockResolvedValue(clean());
  h.runLinear.mockReset().mockResolvedValue(clean());
  h.runGithub.mockReset().mockResolvedValue(clean());
  h.runLinearInbound.mockReset().mockResolvedValue({
    ok: true,
    teams: 1,
    applied: 0,
    adopted: 0,
    noops: 0,
    conflicts: 0,
    errors: [],
    skipped: false,
    skippedReasons: [],
  });
  h.recordIngestRun.mockReset().mockResolvedValue(undefined);
  h.runManualContextPass.mockReset().mockImplementation(async () => {
    h.order.push("context");
    return contextOutcome("complete");
  });
});

describe("runManualSync — the context pass runs ONCE, after everything settles (AC14-02)", () => {
  it("waits for all four runners AND the inbound stage before reconciling", async () => {
    const gates = {
      slack: gate(),
      plane: gate(),
      linear: gate(),
      github: gate(),
      inbound: gate(),
    };
    const leg = (name: keyof typeof gates, value: unknown) => async () => {
      await gates[name].promise;
      h.order.push(name);
      return value;
    };
    h.runSlack.mockImplementation(leg("slack", clean({ created: 1 })));
    h.runPlane.mockImplementation(leg("plane", clean()));
    h.runLinear.mockImplementation(leg("linear", clean()));
    h.runGithub.mockImplementation(leg("github", clean({ created: 2 })));
    h.runLinearInbound.mockImplementation(
      leg("inbound", { ok: true, teams: 1, applied: 1, adopted: 0, noops: 0, conflicts: 0, errors: [], skipped: false, skippedReasons: [] })
    );

    const promise = runManualSync("team-1");

    gates.slack.open();
    gates.plane.open();
    gates.linear.open();
    await settle();
    expect(h.runManualContextPass, "three legs settled is not all of them").not.toHaveBeenCalled();

    gates.github.open();
    await settle();
    expect(h.runManualContextPass, "the inbound stage has not settled yet").not.toHaveBeenCalled();

    gates.inbound.open();
    await promise;

    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(h.runManualContextPass).toHaveBeenCalledWith("team-1", "manual_sync");
    expect(h.order[h.order.length - 1]).toBe("context");
    for (const name of ["slack", "plane", "linear", "github", "inbound"]) {
      expect(h.order.indexOf(name), `${name} must settle before the context pass`).toBeGreaterThanOrEqual(0);
      expect(h.order.indexOf(name)).toBeLessThan(h.order.indexOf("context"));
    }
  });

  it("still reconciles when a leg FAILS — a failed import is not proof that nothing was written", async () => {
    h.runSlack.mockResolvedValue(clean({ ok: false, errors: ["slack: channel C1 is private"] }));
    await runManualSync("team-1");
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
  });

  it("GitHub keeps `force: true` on the manual path (TICKFIT-1 D2f)", async () => {
    await runManualSync("team-1");
    expect(h.runGithub).toHaveBeenCalledWith({ teamId: "team-1", force: true });
  });
});

describe("runManualSync — the context pass is NOT gated on counts or success (AC14-03/AC14-04)", () => {
  const cases: { name: string; arrange: () => void }[] = [
    { name: "every leg reports zero changes", arrange: () => {} },
    {
      name: "a leg returns errors",
      arrange: () => h.runPlane.mockResolvedValue(clean({ ok: false, errors: ["plane: 401"] })),
    },
    {
      name: "a leg THROWS after committing items",
      arrange: () => h.runLinear.mockRejectedValue(new Error("linear: socket hang up")),
    },
    {
      name: "a leg returns errors with ZERO integrations",
      arrange: () =>
        h.runSlack.mockResolvedValue({ ...unconfigured(), ok: false, errors: ["slack: token revoked"] }),
    },
    {
      name: "a leg is SKIPPED by process single-flight",
      arrange: () => h.runGithub.mockResolvedValue({ ...unconfigured(), skipped: true }),
    },
    {
      name: "every connector is unconfigured",
      arrange: () => {
        for (const m of [h.runSlack, h.runPlane, h.runLinear, h.runGithub]) m.mockResolvedValue(unconfigured());
      },
    },
    {
      name: "the inbound stage throws",
      arrange: () => h.runLinearInbound.mockRejectedValue(new Error("inbound: lock held")),
    },
  ];

  it.each(cases)("reconciles exactly once when $name", async ({ arrange }) => {
    arrange();
    await runManualSync("team-1");
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
  });
});

describe("runManualSync — the summary tells the truth about both halves", () => {
  it("appends ONE Project context line carrying the shared message", async () => {
    const r = await runManualSync("team-1");
    expect(r.summary).toContain("**Project context**");
    expect(r.summary).toContain("CTX-complete");
    expect(r.summary.match(/\*\*Project context\*\*/g) ?? []).toHaveLength(1);
  });

  it("reconciliation counts are NOT added to the imported totals", async () => {
    h.runSlack.mockResolvedValue(clean({ created: 1, updated: 2 }));
    for (const m of [h.runPlane, h.runLinear, h.runGithub]) m.mockResolvedValue(unconfigured());

    const r = await runManualSync("team-1");

    expect(r.created, "memberships are not imported items").toBe(1);
    expect(r.updated).toBe(2);
  });

  it("a PENDING context counts as one issue and the headline stops claiming completion", async () => {
    h.runManualContextPass.mockResolvedValue(contextOutcome("pending", "CTX-pending — more work may remain"));

    const r = await runManualSync("team-1");

    expect(r.errors).toBe(1);
    expect(r.summary).toContain("CTX-pending");
    expect(r.summary, "an unconditional 'Scrape complete' would overstate the run").not.toContain(
      "**Scrape complete**"
    );
  });

  it("a FAILED context counts as one issue too", async () => {
    h.runManualContextPass.mockResolvedValue(contextOutcome("failed"));
    const r = await runManualSync("team-1");
    expect(r.errors).toBe(1);
    expect(r.summary).not.toContain("**Scrape complete**");
  });

  it("a COMPLETE context adds no issue and leaves a clean run reading as complete", async () => {
    const r = await runManualSync("team-1");
    expect(r.errors).toBe(0);
    expect(r.summary).toContain("**Scrape complete**");
  });

  it("an error-only result with ZERO integrations keeps its source label and error", async () => {
    h.runSlack.mockResolvedValue({ ...unconfigured(), ok: false, errors: ["slack: token revoked"] });
    for (const m of [h.runPlane, h.runLinear, h.runGithub]) m.mockResolvedValue(unconfigured());

    const r = await runManualSync("team-1");

    expect(r.summary).toContain("Slack");
    expect(r.summary).toContain("token revoked");
    expect(r.errors, "the provider error is still an issue").toBeGreaterThanOrEqual(1);
    expect(
      r.summary,
      "a failed import must not be re-described as 'no connectors are configured'"
    ).not.toContain("No connectors are configured");
  });

  it("a THROWN leg is reported under its own label, not silently dropped", async () => {
    h.runLinear.mockRejectedValue(new Error("linear: socket hang up"));
    const r = await runManualSync("team-1");
    expect(r.summary).toContain("Linear");
    expect(r.summary).toContain("socket hang up");
    expect(r.errors).toBeGreaterThanOrEqual(1);
  });

  it("a SKIPPED leg keeps minimal busy information with retry guidance", async () => {
    h.runGithub.mockResolvedValue({ ...unconfigured(), skipped: true });
    const r = await runManualSync("team-1");
    expect(r.summary).toContain("GitHub");
    expect(r.summary).toMatch(/skipped|already running/i);
    expect(r.summary).toMatch(/try again/i);
    expect(r.summary, "a skip is not an import that succeeded").not.toMatch(/GitHub\*\*: \+0 new/);
  });

  it("an inbound THROW is reported rather than swallowed", async () => {
    h.runLinearInbound.mockRejectedValue(new Error("inbound: lock held"));
    const r = await runManualSync("team-1");
    expect(r.summary).toMatch(/inbound/i);
    expect(r.summary).toContain("lock held");
    expect(r.errors).toBeGreaterThanOrEqual(1);
  });

  it("genuinely unconfigured: the explanation SURVIVES alongside the context result", async () => {
    for (const m of [h.runSlack, h.runPlane, h.runLinear, h.runGithub]) m.mockResolvedValue(unconfigured());

    const r = await runManualSync("team-1");

    expect(r.summary).toContain("No connectors are configured");
    expect(r.summary, "the context pass still ran and still reports").toContain("CTX-complete");
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
  });

  it("the inbound stage keeps its opt-in ordering: no Linear integration → no inbound, still reconciles", async () => {
    h.runLinear.mockResolvedValue(unconfigured());
    await runManualSync("team-1");
    expect(h.runLinearInbound).not.toHaveBeenCalled();
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
  });
});
