import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasUnjudgeableDrop, scoreableDocs, type InferDoc } from "@/lib/dashboard/doc-task-infer";

/**
 * BANNERSTUCK-1 — the contract that lets a healed leg clear a CONFIRMED failure streak without ever
 * being able to hide a live one. Spec: `docs/design/bannerstuck1-confirmed-failure-cannot-clear.md`.
 *
 * The incident: `doc_task_infer` carried a 4-long failure streak from an OpenRouter 402. The credit was
 * restored 26h before the screenshot, the scheduler was ticking, and the banner still read "1 ingestion
 * leg is broken". Nothing could clear it — the streak breaks only on a recorded success, and a leg with
 * no work to do records nothing, so the failure stayed newest forever.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const HEALTH = readFileSync(join(ROOT, "lib", "ingest", "pipeline-health.ts"), "utf8");
const RUN = readFileSync(join(ROOT, "lib", "dashboard", "doc-task-infer-run.ts"), "utf8");

const doc = (over: Partial<InferDoc> = {}): InferDoc => ({
  id: "d",
  memberId: "m1",
  ownerKind: "human",
  title: "t",
  contentSha: "sha",
  access: "team",
  hasDeterministicLink: false,
  ...over,
});

describe("AC8 — the architecture comment no longer carries the claim that let this ship", () => {
  it("does not assert that a persistent failure keeps re-recording", () => {
    // The load-bearing falsehood: true only WHILE the failure persists. Once the cause healed and no
    // work was demanded, nothing re-recorded and the stale failure was indistinguishable from a live one.
    expect(HEALTH).not.toContain("a persistent failure keeps re-recording and stays the newest");
  });

  it("does not claim FIVE outcomes write no row — four of them now write the clearing row", () => {
    expect(HEALTH).not.toContain("FIVE of its");
  });

  it("does not claim a healthy leg writes nothing for days UNCONDITIONALLY", () => {
    // It still writes nothing for days — but only once its verdict is `ok`. The unqualified form is
    // what made the stuck-failure case invisible.
    const idx = HEALTH.indexOf("still writes nothing for days");
    expect(idx, "the sentence should still exist, qualified").toBeGreaterThan(0);
    expect(HEALTH.slice(idx, idx + 200)).toContain("once its verdict is `ok`");
  });

  it("names the mechanism that replaced it", () => {
    expect(HEALTH).toContain("BANNERSTUCK-1");
    expect(HEALTH).toContain("health_clear");
  });
});

describe("AC5b — the clearing row is BACKDATED to the pass's own start", () => {
  /**
   * This is the whole correctness argument (spec §2b): `STREAK_SQL` orders `finished_at desc, id desc`,
   * so a clearing row stamped at the pass's START sorts strictly OLDER than any failure recorded while
   * the pass ran. A guard cannot achieve that — under READ COMMITTED an uncommitted concurrent failure
   * is invisible to the guard's snapshot, so both rows land and the clearing row still wins.
   */
  it("passes `passStartedAt` as BOTH startedAt and finishedAt — never Date.now() at write time", () => {
    const fn = RUN.slice(RUN.indexOf("export async function recordClearingRun"), RUN.indexOf("async function record("));
    expect(fn).toContain("startedAt: passStartedAt");
    expect(fn).toContain("finishedAt: passStartedAt");
    expect(fn, "a Date.now() here empties the ordering window").not.toMatch(/finishedAt:\s*Date\.now\(\)/);
  });

  it("the call site hands it the pass's OWN startedAt", () => {
    // `startedAt` is captured once at pass entry. Recomputing it at write time would collapse the
    // backdating to "now" and silently restore the masking window.
    expect(RUN).toContain("await recordClearingRun(db, teamId, startedAt, reason)");
  });

  it("clearing is gated on a STANDING failure, so the steady state writes nothing", () => {
    // Not a throttle: writing only when the newest verdict is a failure is what keeps the paid-run
    // cooldown untouched (a clearing row that became `lastRun` would defer real scoring by up to 12h).
    expect(RUN).toContain("if (prior?.ok === false)");
  });
});

describe("AC2c/AC2d — which drops mean 'nothing to do' and which mean 'could not judge'", () => {
  it("a CONNECTOR-owned doc is a legitimate nothing-to-do", () => {
    // Connectors are excluded from credit by design, so there is no human to reason about. Blocking
    // this would make the leg never clear for a connector-fed team.
    const docs = [doc({ memberId: null, ownerKind: "connector" })];
    expect(scoreableDocs(docs)).toEqual([]);
    expect(hasUnjudgeableDrop(docs)).toBe(false);
  });

  it("an UNRESOLVABLE owner means the pass judged nothing", () => {
    const docs = [doc({ memberId: null, ownerKind: "unresolvable" })];
    expect(hasUnjudgeableDrop(docs)).toBe(true);
  });

  it("deterministic-linked and external drops are legitimate", () => {
    expect(hasUnjudgeableDrop([doc({ hasDeterministicLink: true })])).toBe(false);
    expect(hasUnjudgeableDrop([doc({ access: "external" })])).toBe(false);
  });

  it("one unjudgeable doc among many legitimate ones still blocks clearing", () => {
    // ∀, not ∃: the pass either observed the whole set or it did not.
    expect(
      hasUnjudgeableDrop([
        doc({ id: "a", hasDeterministicLink: true }),
        doc({ id: "b", memberId: null, ownerKind: "connector" }),
        doc({ id: "c", memberId: null, ownerKind: "unresolvable" }),
      ])
    ).toBe(true);
  });
});

describe("AC2e — a saturated scan has not observed the eligible set", () => {
  it("all THREE JS-derived outcomes are gated on saturation, not just the first", () => {
    // `:206`, `:237` and `:270` are filters over ONE bounded page, so each is a claim about the newest
    // ITEM_SCAN rows only. An earlier draft gated only `:206`.
    // Matcher written against the REAL shape: the `:237` site adds `&& !hasUnjudgeableDrop(docs)`,
    // whose parentheses defeat a lazy `[^)]*`. A matcher that misses the site it is meant to pin is
    // the failure this test exists to catch.
    const gated = RUN.match(/if \(!scanSaturated(?: && [^)]*\([^)]*\))?\) await clearIfHealed\(/g) ?? [];
    expect(gated.length, "expected nothing-to-score x2 and unchanged x1").toBe(3);
    // …and every clearing call that is NOT `no-candidates` must be behind that gate.
    const calls = RUN.match(/await clearIfHealed\("([a-z-]+)"\)/g) ?? [];
    expect(calls.length).toBe(4);
  });

  it("saturation is measured on the raw page, before any JS filtering", () => {
    expect(RUN).toContain("const scanSaturated = items.length >= ITEM_SCAN;");
  });

  it("`no-candidates` is NOT saturation-gated — an empty list is complete at any limit", () => {
    const site = RUN.slice(RUN.indexOf('if (!tasks.length)'), RUN.indexOf('const scanSaturated'));
    expect(site).toContain('await clearIfHealed("no-candidates")');
    expect(site).not.toContain("scanSaturated");
  });
});

describe("the gates that must NOT clear", () => {
  it("neither `cooldown` nor `no-llm` reaches the clearing writer", () => {
    // `cooldown` never ran; `no-llm` is unconfigured — a different state with its own signal. Both sit
    // ABOVE the clearing outcomes, so a write wired one early-return too high would silence the alarm
    // on a leg that did nothing at all.
    const head = RUN.slice(RUN.indexOf("const prior = await lastRun"), RUN.indexOf('if (!tasks.length)'));
    expect(head).not.toContain("clearIfHealed(");
  });
});
