import { describe, expect, it } from "vitest";
import {
  degradedNote,
  deriveLlmState,
  deriveTaskHealth,
  pickReportedFailure,
  taskLabel,
  TASK_RECENCY_MS,
  type LlmRun,
} from "@/lib/query/llm-health";

/**
 * The answering-model leg, LLMOBS-1 / AIO-905.
 *
 * THE BUG: the leg only ever observed narrative-arc synthesis — `recordLlmOutcome` fires on an opt-in
 * and exactly one file used it — yet its copy told operators "Learning arcs and meeting summaries may
 * be blank". It had never observed a meeting summary, so it made a false claim AND a model blanking
 * meeting summaries read `healthy`, which is the silent failure the leg was built to end.
 *
 * These pin the three properties the spec's cold reads blocked on: the per-task split (without which
 * one pass's success masks another's failure), the recency window (without which a task that failed
 * twice and never ran again pins the leg red forever), and copy that names only what was observed.
 */

const NOW = Date.parse("2026-08-14T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const run = (task: string, ok: boolean, at: string, extra: Partial<LlmRun> = {}): LlmRun => ({
  ok,
  task,
  model: extra.model ?? "qwen/qwen3.7-max",
  error: ok ? null : (extra.error ?? "LLM returned empty content (finish_reason=length)"),
  finishedAt: at,
});

describe("deriveTaskHealth — one streak per task", () => {
  it("a task's own two failures confirm it, independently of another task's successes", () => {
    // THE BLOCKER BOTH COLD READS FOUND, in its exact shape. The meetings summary and action-items
    // passes run back-to-back on every trigger with ACTION ITEMS LAST. Under one shared task string a
    // summary-only failure produces `fail, ok` per upload, so the newest row is always `ok` and the
    // leg reads healthy while every summary is blank. Separate tasks is what makes the split real.
    const tasks = deriveTaskHealth(
      [
        run("meeting-actions", true, ago(1 * HOUR)),
        run("meeting-summary", false, ago(2 * HOUR)),
        run("meeting-actions", true, ago(3 * HOUR)),
        run("meeting-summary", false, ago(4 * HOUR)),
      ],
      NOW
    );
    expect(tasks.find((t) => t.task === "meeting-summary")?.state).toBe("degraded");
    expect(tasks.find((t) => t.task === "meeting-actions")?.state).toBe("healthy");
    // …and the leg is the worst of them, so the outage is visible despite the interleaved successes.
    expect(deriveLlmState(tasks)).toBe("degraded");
  });

  it("a lone failure is unstable, not degraded — BANNERFLAP-1's threshold, per task", () => {
    const tasks = deriveTaskHealth(
      [run("arcs", false, ago(1 * HOUR)), run("arcs", true, ago(5 * HOUR))],
      NOW
    );
    expect(tasks[0].state).toBe("unstable");
    expect(deriveLlmState(tasks)).toBe("unstable");
  });

  it("carries each task's OWN model — arcs runs the reasoning model, the rest the query model", () => {
    // A leg-level model name would send an operator to the wrong picker.
    const tasks = deriveTaskHealth(
      [
        run("arcs", false, ago(1 * HOUR), { model: "qwen/qwen3.7-plus" }),
        run("arcs", false, ago(2 * HOUR), { model: "qwen/qwen3.7-plus" }),
        run("meeting-summary", false, ago(3 * HOUR), { model: "qwen/qwen3.7-max" }),
        run("meeting-summary", false, ago(4 * HOUR), { model: "qwen/qwen3.7-max" }),
      ],
      NOW
    );
    expect(tasks.find((t) => t.task === "arcs")?.model).toBe("qwen/qwen3.7-plus");
    expect(tasks.find((t) => t.task === "meeting-summary")?.model).toBe("qwen/qwen3.7-max");
  });
});

describe("the recency window — a dead task cannot pin the leg red forever", () => {
  it("EXCLUDES a task whose newest run is older than the window", () => {
    // Two meeting-summary failures in March, no meeting uploaded since. Without this the card is
    // degraded in August naming a feature nobody has used, unfixable by any operator action.
    const stale = TASK_RECENCY_MS + DAY;
    const tasks = deriveTaskHealth(
      [run("meeting-summary", false, ago(stale)), run("meeting-summary", false, ago(stale + HOUR))],
      NOW
    );
    expect(tasks).toEqual([]);
    expect(deriveLlmState(tasks)).toBe("unknown");
  });

  it("INCLUDES a task inside the window — the exclusion must not swallow live evidence", () => {
    // The control for the test above: same shape, inside the window, still loud.
    const fresh = TASK_RECENCY_MS - DAY;
    const tasks = deriveTaskHealth(
      [run("meeting-summary", false, ago(fresh)), run("meeting-summary", false, ago(fresh + HOUR))],
      NOW
    );
    expect(tasks).toHaveLength(1);
    expect(deriveLlmState(tasks)).toBe("degraded");
  });

  it("ages tasks out INDEPENDENTLY — a stale task cannot mute a live one", () => {
    const tasks = deriveTaskHealth(
      [
        run("meeting-summary", false, ago(1 * HOUR)),
        run("meeting-summary", false, ago(2 * HOUR)),
        run("attribution", true, ago(TASK_RECENCY_MS + DAY)),
      ],
      NOW
    );
    expect(tasks.map((t) => t.task)).toEqual(["meeting-summary"]);
    expect(deriveLlmState(tasks)).toBe("degraded");
  });
});

describe("deriveLlmState — the leg is the worst of its tasks", () => {
  it("is unknown with no runs at all, and with no PARTICIPATING tasks", () => {
    expect(deriveLlmState(deriveTaskHealth([], NOW))).toBe("unknown");
    expect(deriveLlmState([])).toBe("unknown");
  });

  it("takes degraded over unstable over healthy", () => {
    const tasks = deriveTaskHealth(
      [
        run("arcs", true, ago(1 * HOUR)),
        run("attribution", false, ago(2 * HOUR)),
        run("attribution", true, ago(3 * HOUR)),
        run("meeting-summary", false, ago(4 * HOUR)),
        run("meeting-summary", false, ago(5 * HOUR)),
      ],
      NOW
    );
    expect(tasks.find((t) => t.task === "arcs")?.state).toBe("healthy");
    expect(tasks.find((t) => t.task === "attribution")?.state).toBe("unstable");
    expect(deriveLlmState(tasks)).toBe("degraded");
  });
});

describe("degradedNote — names what was observed, and only that", () => {
  it("does NOT claim meeting summaries are affected when only arcs failed", () => {
    // The original false claim, in one assertion. The old copy said "Learning arcs and meeting
    // summaries may be blank" for EVERY failure, about a feature the leg had never observed.
    const tasks = deriveTaskHealth(
      [run("arcs", false, ago(1 * HOUR)), run("arcs", false, ago(2 * HOUR))],
      NOW
    );
    const note = degradedNote(tasks);
    expect(note).toContain("Learning arcs");
    expect(note).not.toContain("meeting summaries");
  });

  it("names EVERY confirmed-failing task, each with its own model", () => {
    const tasks = deriveTaskHealth(
      [
        run("arcs", false, ago(1 * HOUR), { model: "qwen/qwen3.7-plus" }),
        run("arcs", false, ago(2 * HOUR), { model: "qwen/qwen3.7-plus" }),
        run("meeting-summary", false, ago(3 * HOUR), { model: "qwen/qwen3.7-max" }),
        run("meeting-summary", false, ago(4 * HOUR), { model: "qwen/qwen3.7-max" }),
      ],
      NOW
    );
    const note = degradedNote(tasks);
    expect(note).toContain("Learning arcs");
    expect(note).toContain("meeting summaries");
    // Both models named — a two-task outage fronted by one model's name is the same class of false
    // attribution this slice removes.
    expect(note).toContain("qwen/qwen3.7-plus");
    expect(note).toContain("qwen/qwen3.7-max");
  });

  it("says what is STILL WORKING when only some tasks fail", () => {
    const tasks = deriveTaskHealth(
      [
        run("arcs", true, ago(1 * HOUR)),
        run("meeting-summary", false, ago(2 * HOUR)),
        run("meeting-summary", false, ago(3 * HOUR)),
      ],
      NOW
    );
    expect(degradedNote(tasks)).toMatch(/Still working:.*Learning arcs/);
  });

  it("attaches the reasoning-starvation hint only when that is the actual error", () => {
    const starved = deriveTaskHealth(
      [
        run("arcs", false, ago(1 * HOUR), { error: "LLM returned empty content (finish_reason=length)" }),
        run("arcs", false, ago(2 * HOUR), { error: "LLM returned empty content (finish_reason=length)" }),
      ],
      NOW
    );
    // ⚠️ THE WORDING MOVED, THE CONTRACT DID NOT (LLMCREDIT-3). The starvation hint now comes from the
    // shared `diagnoseProviderFault` classifier, so this surface and the ingestion banner cannot drift
    // apart on the one fault they both already knew about. Pinning the retired phrase
    // (/reasoning model starving/) would pin the implementation; what this test is FOR is that a
    // starved model is diagnosed as such and sent to the right picker — so that is what it asserts.
    expect(degradedNote(starved)).toMatch(/hidden reasoning/i);
    expect(degradedNote(starved)).toContain("Admin → Active answering model");

    const other = deriveTaskHealth(
      [
        run("attribution", false, ago(1 * HOUR), { error: "HTTP 429 insufficient_quota" }),
        run("attribution", false, ago(2 * HOUR), { error: "HTTP 429 insufficient_quota" }),
      ],
      NOW
    );
    expect(degradedNote(other)).not.toMatch(/hidden reasoning/i);
    expect(degradedNote(other)).toContain("429");
  });

  it("is empty when nothing is confirmed-failing", () => {
    expect(degradedNote([])).toBe("");
  });
});

describe("taskLabel", () => {
  it("maps known slugs to operator copy", () => {
    expect(taskLabel("meeting-summary")).toBe("meeting summaries");
    expect(taskLabel("arcs")).toBe("Learning arcs");
  });

  it("falls back readably for an unmapped slug — the guard guarantees new ones appear", () => {
    // A raw slug in an operator sentence is the defect; the fallback is the steady state after any new
    // generation feature, not an error path.
    //
    // The example used to be `doc-task-infer`, which LLMOBS-2 then MAPPED — so this assertion started
    // failing on correct code. That is the fallback test doing its job: it demonstrates the unmapped
    // path, so its example has to be a slug that is genuinely unmapped, and any placeholder will keep
    // becoming real as the vocabulary grows. Hence an obviously-fictional one.
    expect(taskLabel("some-future-feature")).toBe("a background task (some-future-feature)");
  });
});

describe("pickReportedFailure — the singular fields must not describe a HEALED task", () => {
  const T = (task: string, state: "healthy" | "unstable" | "degraded", model: string, failedAgo: number | null) => ({
    task,
    state,
    model,
    lastError: failedAgo === null ? null : "err",
    diagnosis: null,
    lastFailedAt: failedAgo === null ? null : ago(failedAgo),
    lastOkAt: null,
  });

  it("ignores a healed blip whose failure is NEWER than the real outage", () => {
    // The regression both reviewers found. `arcs` blipped 30 min ago and healed 10 min ago — this
    // install's measured normal — while `meeting-summary` has been confirmed-failing for hours. The
    // healed task's failure row is the NEWEST failure, so a naive "newest failing row" picks it and
    // the card names the reasoning model during a query-model outage.
    const picked = pickReportedFailure([
      T("arcs", "healthy", "reasoning-model", 30 * 60_000),
      T("meeting-summary", "degraded", "query-model", 3 * HOUR),
    ]);
    expect(picked?.task).toBe("meeting-summary");
    expect(picked?.model).toBe("query-model");
  });

  it("prefers a DEGRADED task over an unstable one, even when the unstable failure is newer", () => {
    const picked = pickReportedFailure([
      T("attribution", "unstable", "query-model", 1 * HOUR),
      T("meeting-summary", "degraded", "query-model", 5 * HOUR),
    ]);
    expect(picked?.task).toBe("meeting-summary");
  });

  it("is undefined when every task is healthy — a green leg reports no failure at all", () => {
    expect(pickReportedFailure([T("arcs", "healthy", "m", 2 * HOUR)])).toBeUndefined();
    expect(pickReportedFailure([])).toBeUndefined();
  });
});

describe("degradedNote — 'Still working' is an observation, not a guess", () => {
  it("does NOT list an unstable task, whose newest run just failed", () => {
    // `state !== "degraded"` would list it; its own newest observation contradicts the claim.
    const tasks = deriveTaskHealth(
      [
        run("meeting-summary", false, ago(1 * HOUR)),
        run("meeting-summary", false, ago(2 * HOUR)),
        run("attribution", false, ago(30 * 60_000)),
        run("attribution", true, ago(3 * HOUR)),
        run("arcs", true, ago(4 * HOUR)),
      ],
      NOW
    );
    expect(tasks.find((t) => t.task === "attribution")?.state).toBe("unstable");
    const note = degradedNote(tasks);
    expect(note).toMatch(/Still working:.*Learning arcs/);
    expect(note).not.toMatch(/Still working:.*attribution/);
  });
});
