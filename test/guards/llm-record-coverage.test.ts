import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-FAILING GUARD: a generation feature cannot silently join the UNOBSERVED set (LLMOBS-1).
 *
 * WHY THIS EXISTS — it is the whole shape of the bug. `lib/llm/complete` records a `source='llm'`
 * outcome row only when a caller passes `record:`. Exactly ONE file ever did, so the "Answering model"
 * health leg watched narrative-arc synthesis and spoke for everything — including a note naming
 * meeting summaries it had never observed. Nothing failed; nothing warned; the gap was invisible
 * because it is an ABSENCE, and no test asserts an absence it does not know about.
 *
 * So the invariant is inverted: every call site is either recorded or LISTED. A new generation feature
 * that forgets `record:` reddens the build, and one that deliberately opts out has to say so here, in
 * writing, next to the reason.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(ROOT, "lib");

/**
 * Call sites that deliberately do NOT record, each with the reason. Keeping this list SHORT is the
 * point; every entry is a feature the answering-model leg is blind to.
 */
const EXEMPT: Record<string, string> = {
  // BOTH FAN-OUT ENTRIES ARE GONE (LLMOBS-2). `timeline-summary` now records ONE row per pass via
  // `withLlmPass`, and `doc-task-infer-run` takes an ordinary per-call `record:` — its exemption
  // reason here claimed "one call per scored doc", which was FALSE: the code says ONE CALL PER WORKER,
  // 2-3 per 12h tick. That stale reason was then copied into a spec and nearly justified an API change
  // for a call shape that does not exist. An exemption is a claim, and claims rot.
  "lib/social/generate.ts":
    "Reaches the primitive through `lib/social/llm.ts`'s re-export, and whether social generation " +
    "belongs on the ANSWERING-MODEL leg at all is a product question, not an oversight.",
  // NOTE: `lib/social/llm.ts`, `lib/llm/cost.ts` and `lib/query/embeddings.ts` were listed here in a
  // first draft and the stale-exemption check below rejected them — none of them actually CALLS the
  // primitive (social/llm.ts only re-exports it). The list is shorter than it looked, which is the
  // right direction: every entry is a feature the leg is blind to.
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** Files under `lib/` that call the shared completion primitive. */
function callSites(): { file: string; src: string }[] {
  return tsFiles(LIB)
    .map((full) => ({ file: path.relative(ROOT, full), src: readFileSync(full, "utf8") }))
    // The primitive's own module defines them; it is not a call site.
    .filter(({ file, src }) => file !== "lib/llm/complete.ts" && /\bcompleteText(OrNull)?\s*\(/.test(src));
}

/**
 * THE CALL SITES, pinned — added because two mutations SURVIVED the first version of this slice's
 * tests, and they were the two that mattered most:
 *
 *   • giving both meetings passes ONE task string (the blocker both spec reviewers found) — every
 *     test stayed green, because the unit tests exercise the DERIVATION with hand-built runs and the
 *     data-mechanics test seeds `ingest_runs` directly. Neither goes through the wrapper.
 *   • deleting `record:` from the meetings wrapper entirely — also green, for the same reason. The
 *     spec's own criterion said to enter at a PRODUCTION path and the first draft of the dm test did
 *     not.
 *
 * A derivation is perfectly correct in isolation while nothing wires it — this repo's "pin the call
 * site, not the function" rule, learned the same way.
 */
describe("guard: the meetings passes record, under DISTINCT task names", () => {
  const wrapper = readFileSync(path.join(ROOT, "lib", "meetings", "llm-extract.ts"), "utf8");
  const actions = readFileSync(path.join(ROOT, "lib", "meetings", "action-items.ts"), "utf8");

  it("the shared wrapper derives `record` from the meter it already receives", () => {
    // `meter` bills to llm_usage; `record` files the OUTCOME the health leg reads. Only `meter` was
    // wired for years, which is why the leg had never observed a meeting summary.
    expect(wrapper).toMatch(/record:\s*meter && task \? \{ db: meter\.db, teamId: meter\.teamId, task \}/);
  });

  it("the summary pass and the action-items pass use DIFFERENT task strings", () => {
    const summaryTask = /callMeetingsLLM\([\s\S]*?,\s*"([a-z-]+)"\s*\)/.exec(wrapper)?.[1];
    const actionsTask = /callMeetingsLLM\([\s\S]*?,\s*"([a-z-]+)"\s*\)/.exec(actions)?.[1];
    expect(summaryTask, "the summary pass passes no task string").toBeTruthy();
    expect(actionsTask, "the action-items pass passes no task string").toBeTruthy();
    // THE REGRESSION: they run back-to-back on every trigger with action items LAST, so one shared
    // name makes the later success mask the earlier failure — the leg reads healthy while every
    // meeting summary is blank.
    expect(
      summaryTask,
      "both meetings passes share a task string; the action-items success will mask a summary failure"
    ).not.toBe(actionsTask);
    expect(summaryTask).toBe("meeting-summary");
    expect(actionsTask).toBe("meeting-actions");
  });
});

describe("guard: every generation call site records its outcome, or is listed", () => {
  it("finds call sites at all — a guard that matches nothing proves nothing", () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(5);
    // The site the whole ticket is about: if this stops matching, the guard has lost its subject.
    expect(sites.map((s) => s.file)).toContain("lib/meetings/llm-extract.ts");
  });

  it("every call site passes `record:` or appears in EXEMPT with a reason", () => {
    const unlisted = callSites()
      .filter(({ file, src }) => !/record:\s/.test(src) && !(file in EXEMPT))
      .map((s) => s.file);
    expect(
      unlisted,
      "these call sites neither record their outcome nor declare why not, so the answering-model " +
        "health leg is silently blind to them — the exact shape of LLMOBS-1:\n" + unlisted.join("\n")
    ).toEqual([]);
  });

  it("every EXEMPT entry still exists and still calls the primitive — no stale exemptions", () => {
    // An exemption for a file that no longer calls the primitive is dead weight that makes the list
    // look longer (and the blind spot bigger) than it is.
    const live = new Set(callSites().map((s) => s.file));
    const stale = Object.keys(EXEMPT).filter((f) => !live.has(f));
    expect(stale, `stale exemptions — these no longer call the primitive:\n${stale.join("\n")}`).toEqual([]);
  });

  it("every exemption carries a non-trivial reason", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${file}'s exemption reason is too thin to be a decision`).toBeGreaterThan(40);
    }
  });
});
