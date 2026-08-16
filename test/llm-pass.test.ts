import { describe, expect, it, vi } from "vitest";
import {
  failLlmPassBeforeFirstCall,
  finishLlmPass,
  recordLlmOutcome,
  withLlmPass,
  type LlmPass,
} from "@/lib/llm/complete";

/**
 * ONE ROW PER PASS — LLMOBS-2.
 *
 * `recordLlmOutcome` writes a row per call, and `attachPersonDaySummaries` calls the model once per
 * (person, day) on every rebuild — 37.9 calls/day measured, against a 50-row Recent-runs panel. So
 * LLMOBS-1 left that site unrecorded, and its FOUNDING failure mode stayed open for its highest-volume
 * feature: a model failing every timeline summary reads `healthy`.
 *
 * These pin the pass contract, and most of them exist because a cold read found the first draft would
 * have got them wrong: the row must carry `meta.model` and an error or the health card silently loses
 * the model name and the reasoning hint; a QUIET pass and a pass that FAILED BEFORE ITS FIRST CALL are
 * different things; and the callback throwing must still write the row.
 */

/** Capture what the pass would write, without a database. */
function captureRuns(): { rows: Record<string, unknown>[]; db: unknown } {
  const rows: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        rows.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { rows, db };
}

/**
 * `recordIngestRun` JSON-serialises `meta` and `errors` before the insert (the pg adapter needs jsonb
 * as text), so a captured row holds strings, not objects. Parsing here rather than asserting on the
 * serialized shape keeps the tests about the CONTRACT instead of the storage encoding.
 */
const metaOf = (row: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(String(row.meta)) as Record<string, unknown>;
const errorsOf = (row: Record<string, unknown>): string[] => JSON.parse(String(row.errors)) as string[];

/** Drive a pass's counters the way `recordLlmOutcome` does, without going through the HTTP path. */
function call(pass: LlmPass, ok: boolean, model = "qwen/qwen3.7-max", error = "LLM returned empty content"): void {
  pass.calls += 1;
  pass.model = pass.model ?? model;
  if (!ok) {
    pass.failures += 1;
    pass.firstError = pass.firstError ?? error;
  }
}

describe("the pass row — one per pass, and what it must carry", () => {
  it("writes ONE row for N calls, with the real counts", async () => {
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      for (let i = 0; i < 40; i++) call(pass, i !== 7); // one failure among forty
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    const meta = metaOf(rows[0]) as { calls: number; failures: number; task: string };
    expect(meta.calls).toBe(40);
    expect(meta.failures).toBe(1);
    expect(meta.task).toBe("timeline-summary");
  });

  it("is ok:false only when EVERY call failed", async () => {
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      for (let i = 0; i < 5; i++) call(pass, false);
    });
    expect(rows[0].ok).toBe(false);
  });

  it("a single success clears the pass — the accepted cost, pinned so it is not a surprise", async () => {
    // Stated at its real strength: not "50% failing reads ok" — ONE success in forty does. Pinned
    // deliberately, because an accepted cost nobody wrote down is just a bug with a good story.
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      call(pass, true);
      for (let i = 0; i < 39; i++) call(pass, false);
    });
    expect(rows[0].ok).toBe(true);
    expect((metaOf(rows[0]) as { failures: number }).failures).toBe(39);
  });

  it("carries meta.model and the FIRST failure's error — the health card reads both", async () => {
    // Without these, `deriveTaskHealth` gets `model: null` and `degradedNote` loses the model name and
    // the "pick a non-reasoning model" hint — reinstating the wrong-picker misattribution LLMOBS-1
    // existed to remove. Review caught the first draft specifying neither.
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      call(pass, false, "qwen/qwen3.7-plus", "LLM returned empty content (finish_reason=length)");
      call(pass, false, "qwen/qwen3.7-plus", "a later, different error");
    });
    expect((metaOf(rows[0]) as { model: string }).model).toBe("qwen/qwen3.7-plus");
    expect(errorsOf(rows[0])[0]).toContain("finish_reason=length");
  });
});

describe("quiet vs failed-before-the-first-call — a distinction the first draft collapsed", () => {
  it("a QUIET pass (nothing to do) writes NO row", async () => {
    // `ok: true` would claim a model that was never asked; `ok: false` would accuse on no evidence.
    // An absent row also cannot break a real failure streak.
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async () => {});
    expect(rows).toHaveLength(0);
  });

  it("a pass that FAILED BEFORE ITS FIRST CALL writes ok:false with calls:0", async () => {
    // `attachPersonDaySummaries` returns degraded with zero calls when key resolution throws — which
    // the code itself calls "a failure, not a configuration choice". Under the first draft that was an
    // empty pass and therefore silent FOREVER: `llm` has no staleness clock, is not a pipeline leg,
    // and ages to `unknown` after 14 days. Both reviewers found it.
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      failLlmPassBeforeFirstCall(pass, "could not resolve the answering model's keys");
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    const meta = metaOf(rows[0]) as { calls: number; failures: number };
    expect(meta.calls).toBe(0);
    expect(errorsOf(rows[0])[0]).toContain("could not resolve");
  });
});

describe("the pass always settles", () => {
  it("writes the row when the callback THROWS after a call, and re-throws", async () => {
    // The happy path never exercises the `finally`. Review asked for this branch explicitly — and then
    // for the NAME to be honest: a throw before the first call is a different case, below.
    const { rows, db } = captureRuns();
    await expect(
      withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
        call(pass, false);
        throw new Error("rebuild blew up");
      })
    ).rejects.toThrow("rebuild blew up");
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
  });

  it("is idempotent — an explicit finish plus the helper's own writes ONE row", async () => {
    // NOT for "a `finally` after an early return", which runs exactly once — review showed that
    // rationale was impossible. The real shape is a builder adding a defensive explicit finish
    // alongside the one the helper already guarantees. Two rows for one pass would be two streak
    // entries for one event.
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      call(pass, true);
      await finishLlmPass(pass);
    });
    expect(rows).toHaveLength(1);
  });

  it("observability cannot break the caller — a failing write does not surface", async () => {
    const db = { from: () => ({ insert: () => Promise.reject(new Error("db down")) }) };
    await expect(
      withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
        call(pass, true);
        return "result";
      })
    ).resolves.toBe("result");
  });
});

describe("the branded token cannot be mistaken for a per-call record", () => {
  it("a pass accumulates instead of writing per call", async () => {
    // If `recordLlmOutcome` took the per-call branch, this would be 3 rows — the flood, restored,
    // invisibly (the coverage guard matches `record: pass` just as happily).
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      call(pass, true);
      call(pass, true);
      call(pass, true);
    });
    expect(rows).toHaveLength(1);
  });

  it("carries a real runtime brand — a type-only one would narrow to the per-call branch", () => {
    // The first attempt used `declare const PASS_BRAND: unique symbol`, which exists only in the type
    // system: `[PASS_BRAND]` was `undefined` at runtime and every test blew up. A brand that is not
    // really there is worse than none, because `isPass` narrows on it.
    const seen = vi.fn();
    return withLlmPass(
      { db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } as never, teamId: "t", task: "timeline-summary" },
      async (pass) => {
        expect(Object.getOwnPropertySymbols(pass).length).toBeGreaterThan(0);
        expect(pass.calls).toBe(0);
        seen();
      }
    ).then(() => expect(seen).toHaveBeenCalled());
  });
});

describe("the REAL integration — `record: pass` must reach the accumulator, not the per-call write", () => {
  /**
   * These exist because two mutations survived the first suite: making `isPass` duck-type on counters
   * instead of the brand, and making `recordLlmOutcome` skip the pass branch entirely — the per-call
   * FLOOD, restored, which is the whole defect this slice removes. Both survived because every other
   * test in this file drives `pass.calls++` through a local helper that SIMULATES what
   * `recordLlmOutcome` does. A simulation of the integration is not the integration, and this repo's
   * rule is to pin the call site rather than the function.
   */
  it("a PASS accumulates and writes nothing per call", async () => {
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      await recordLlmOutcome(pass, { ok: true, model: "m1", startedAt: Date.now() });
      await recordLlmOutcome(pass, { ok: false, model: "m1", error: "boom", startedAt: Date.now() });
      // Nothing may be written yet — the row is the pass's, at the end.
      expect(rows).toHaveLength(0);
      expect(pass.calls).toBe(2);
      expect(pass.failures).toBe(1);
      expect(pass.model).toBe("m1");
      expect(pass.firstError).toBe("boom");
    });
    expect(rows).toHaveLength(1);
  });

  it("a PER-CALL record still writes immediately — the other branch is not collateral damage", async () => {
    const { rows, db } = captureRuns();
    await recordLlmOutcome({ db: db as never, teamId: "t", task: "arcs" }, {
      ok: false,
      model: "m2",
      error: "empty content",
      startedAt: Date.now(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect((metaOf(rows[0]) as { task: string }).task).toBe("arcs");
  });

  it("narrows on the BRAND, so a token with the right shape but no brand is treated per-call", () => {
    // The mutation this kills: `isPass` duck-typing on `calls`/`done`. A caller could then hand in a
    // look-alike and get accumulated silently — or, renaming a counter, every real pass would fall
    // through to the per-call write.
    const lookalike = { db: {} as never, teamId: "t", task: "timeline-summary", calls: 0, failures: 0, done: false };
    const { rows, db } = captureRuns();
    return recordLlmOutcome({ ...lookalike, db: db as never } as never, {
      ok: true,
      model: "m",
      startedAt: Date.now(),
    }).then(() => {
      // No brand ⇒ per-call branch ⇒ a row now.
      expect(rows).toHaveLength(1);
    });
  });
});

describe("a throw BEFORE the first call is evidence, not absence", () => {
  it("records ok:false with calls:0 when the body throws having called nothing", async () => {
    // Review found `try/finally` alone could not tell this from a QUIET pass — both hit
    // `calls === 0 && failures === 0` and wrote nothing, leaving `llm` (no staleness clock, ages to
    // `unknown` at 14d) silent forever. Only the one branch that marks itself explicitly was covered.
    const { rows, db } = captureRuns();
    await expect(
      withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async () => {
        throw new Error("prompt construction blew up");
      })
    ).rejects.toThrow("prompt construction blew up");
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect((metaOf(rows[0]) as { calls: number }).calls).toBe(0);
    expect(errorsOf(rows[0])[0]).toContain("prompt construction blew up");
  });
});

describe("a PARTIAL failure keeps its error text", () => {
  it("carries firstError in meta even on an ok pass", async () => {
    // `errors` must stay empty on an ok pass or `recordIngestRun` flips it to failed — so without
    // this, a 39-of-40 pass recorded its counts and dropped what actually went wrong, for what the
    // timeline site itself calls "the common outcome of a flaky or rate-limited provider".
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      call(pass, true);
      for (let i = 0; i < 39; i++) call(pass, false, "m", "HTTP 429 rate limited");
    });
    expect(rows[0].ok).toBe(true);
    expect(errorsOf(rows[0])).toEqual([]); // must stay empty, or ok flips
    expect((metaOf(rows[0]) as { firstError: string }).firstError).toBe("HTTP 429 rate limited");
  });

  it("records a real duration rather than a fabricated zero", async () => {
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      call(pass, true);
      await new Promise((r) => setTimeout(r, 12));
    });
    expect(Number(rows[0].duration_ms)).toBeGreaterThan(0);
  });

  it("writes a null model rather than an empty string when none was seen", async () => {
    const { rows, db } = captureRuns();
    await withLlmPass({ db: db as never, teamId: "t", task: "timeline-summary" }, async (pass) => {
      failLlmPassBeforeFirstCall(pass, "no keys");
    });
    expect((metaOf(rows[0]) as { model: string | null }).model).toBeNull();
  });
});
