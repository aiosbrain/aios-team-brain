import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DOC_TASK_INFER_SOURCE,
  recordClearingRun,
  runDocTaskInference,
} from "@/lib/dashboard/doc-task-infer-run";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { saveProviderModel, setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * BANNERSTUCK-1 — a CONFIRMED failure streak that nothing can clear.
 * Spec: `docs/design/bannerstuck1-confirmed-failure-cannot-clear.md`.
 *
 * Measured on prod 2026-08-27: `doc_task_infer` carried 4 consecutive failures from an OpenRouter 402.
 * The credit was restored 26h earlier and the scheduler was ticking, but the loud banner still read
 * "1 ingestion leg is broken — the brain isn't getting fresh data", and NO future event could clear it:
 * the streak breaks only on a recorded success, and a leg with nothing to do records nothing.
 *
 * Real Postgres because the whole verdict lives in `STREAK_SQL`'s window functions and its
 * `finished_at desc, id desc` ordering — which is also the mechanism that stops a clearing row hiding a
 * concurrent failure. A stubbed streak would pass while the SQL was wrong.
 */

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString();
/** Comfortably past the 12h cooldown (whose floor is 1h), so a seeded failure does not gate the pass. */
const PAST_COOLDOWN_MS = 30 * 3_600_000;

async function member(teamId: string): Promise<string> {
  const { data } = await db().from("members").select("id").eq("team_id", teamId)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (data as { id: string }).id;
}

/** Get the pass PAST `no-llm` (`:151`) — without this every clearing test dies one gate too early. */
async function withModel(teamId: string): Promise<void> {
  const a = { teamId, memberId: await member(teamId) };
  await upsertIntegration(db(), a, { type: "openai", name: "openai", config: {}, status: "enabled" });
  const { data } = await db().from("integrations").select("id").eq("team_id", teamId)
    .eq("type", "openai").order("created_at", { ascending: true }).limit(1).maybeSingle();
  await setIntegrationSecret(db(), a, (data as { id: string }).id, "sk-openai-test");
  await saveProviderModel(db(), a, "openai", "gpt-4.1");
}

/** A recorded run of this leg. `at` sets BOTH ends — `finished_at` is what the streak query orders by. */
async function run(seed: Seed, opts: { ok: boolean; agoMs: number }): Promise<void> {
  // `recordIngestRun` with epoch-MS timestamps, not a raw insert: it is the writer every other leg
  // uses, and `finished_at` is what the streak query orders by. (tsc cannot catch a mistake here —
  // `tsconfig` excludes the test tree.)
  const at = Date.now() - opts.agoMs;
  await recordIngestRun(db(), {
    teamId: seed.teamId, source: DOC_TASK_INFER_SOURCE, trigger: "scheduler",
    ok: opts.ok, created: 0, errors: opts.ok ? [] : ["every worker failed"],
    startedAt: at, finishedAt: at,
  });
}

/**
 * The incident state: a CONFIRMED streak (`FAILURES_TO_CONFIRM` = 2), aged past the cooldown so the
 * pass is not gated by its own seed — the fixture trap Fable's review named.
 */
async function confirmedFailureStreak(seed: Seed): Promise<void> {
  await run(seed, { ok: false, agoMs: PAST_COOLDOWN_MS + 3_600_000 });
  await run(seed, { ok: false, agoMs: PAST_COOLDOWN_MS });
}

async function isFailing(seed: Seed): Promise<boolean> {
  const h = await getPipelineHealth(seed.teamId);
  return h.failing.some((l) => l.source === DOC_TASK_INFER_SOURCE);
}

async function rowCount(seed: Seed): Promise<number> {
  const { data } = await db().from("ingest_runs").select("id")
    .eq("team_id", seed.teamId).eq("source", DOC_TASK_INFER_SOURCE);
  return (data ?? []).length;
}

async function doc(seed: Seed, over: Record<string, unknown> = {}) {
  return ingest(seed, {
    kind: "deliverable", path: `2-work/${randomUUID()}.md`, access: "team",
    body: "prose about some work",
    frontmatter: { source: "", title: "A design doc", updated: recentIso },
    ...over,
  });
}

/** A project to hang fixtures on — both `items` and `tasks` have a NOT NULL `project_id`. */
async function project(seed: Seed): Promise<string> {
  const { data, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "P" })
    .select("id").single();
  if (error) throw new Error(`projects insert failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function task(seed: Seed, projectId?: string): Promise<void> {
  const proj = { id: projectId ?? (await project(seed)) };
  const { error } = await db().from("tasks").insert({
    team_id: seed.teamId, project_id: proj.id,
    row_key: `TSK-${randomUUID().slice(0, 6)}`,
    title: "Some task", status: "in_progress", origin: "sync", audience: "team",
  });
  if (error) throw new Error(`tasks insert failed: ${error.message}`);
}

describe("BANNERSTUCK-1 — a healed leg can clear, and can never hide a live failure", () => {
  it("AC0 — REPRODUCES the incident: a confirmed streak is loud, and an idle pass used to leave it so", async () => {
    // The non-vacuity control for everything below. If this were not `failing`, every clearing
    // assertion would pass for the wrong reason.
    const seed = await seedTeam();
    await confirmedFailureStreak(seed);
    expect(await isFailing(seed)).toBe(true);
  });

  it("AC1 — `no-candidates`: a pass that read the task list and found none clears the streak", async () => {
    const seed = await seedTeam();
    await withModel(seed.teamId);
    await doc(seed);
    await confirmedFailureStreak(seed);
    expect(await isFailing(seed)).toBe(true);

    expect((await runDocTaskInference(db(), seed.teamId)).skipped).toBe("no-candidates");
    expect(await isFailing(seed), "a clean idle pass is contrary evidence").toBe(false);
  });

  it("AC1 — the clearing row is `ok`, marked, and BACKDATED to the pass start", async () => {
    const seed = await seedTeam();
    await withModel(seed.teamId);
    await doc(seed);
    await confirmedFailureStreak(seed);
    const before = Date.now();
    await runDocTaskInference(db(), seed.teamId);

    const { data } = await db().from("ingest_runs")
      .select("ok, meta, started_at, finished_at")
      .eq("team_id", seed.teamId).eq("source", DOC_TASK_INFER_SOURCE)
      .order("finished_at", { ascending: false }).limit(1).maybeSingle();
    const row = data as { ok: boolean; meta: Record<string, unknown>; started_at: string; finished_at: string };
    expect(row.ok).toBe(true);
    expect(row.meta.health_clear).toBe(true);
    // finished_at === started_at is the ordering mechanism, not a cosmetic choice.
    expect(Date.parse(row.finished_at)).toBe(Date.parse(row.started_at));
    expect(Date.parse(row.finished_at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("AC2 — `cooldown` does NOT clear: a pass that never ran proves nothing", async () => {
    // If this cleared, the alarm could be silenced by doing nothing — strictly worse than the bug.
    const seed = await seedTeam();
    await withModel(seed.teamId);
    await doc(seed);
    await run(seed, { ok: false, agoMs: 2 * 3_600_000 });
    await run(seed, { ok: false, agoMs: 60_000 }); // newest failure is INSIDE the cooldown
    const n = await rowCount(seed);

    expect((await runDocTaskInference(db(), seed.teamId)).skipped).toBe("cooldown");
    expect(await rowCount(seed), "no row written").toBe(n);
    expect(await isFailing(seed)).toBe(true);
  });

  it("AC2b — `no-llm` does NOT clear: unconfigured is a different state", async () => {
    // `no-llm` sits one gate ABOVE the clearing outcomes, so a write wired one early-return too high
    // would silence the alarm for every team that has no model at all.
    const seed = await seedTeam(); // deliberately no `withModel`
    await doc(seed);
    await confirmedFailureStreak(seed);
    const n = await rowCount(seed);

    expect((await runDocTaskInference(db(), seed.teamId)).skipped).toBe("no-llm");
    expect(await rowCount(seed)).toBe(n);
    expect(await isFailing(seed)).toBe(true);
  });

  it("AC5 — a clearing row can NEVER outrank a failure recorded while the pass ran", async () => {
    /**
     * The masking scenario, made deterministic. Two callers reach this leg and are not mutually
     * single-flighted, so an idle pass can overlap a failing one. A `Promise.all` race would be
     * green-by-construction (an idle pass has no awaitable seam), so the seam is exercised directly:
     * a pass that STARTED five minutes ago finishes after a failure that just landed.
     */
    const seed = await seedTeam();
    await confirmedFailureStreak(seed);
    const passStartedAt = Date.now() - 5 * 60_000;

    // The concurrent failure lands NOW — after our pass began.
    await recordIngestRun(db(), {
      teamId: seed.teamId, source: DOC_TASK_INFER_SOURCE, trigger: "scheduler",
      ok: false, errors: ["every worker failed"], startedAt: Date.now() - 1000,
    });
    await recordClearingRun(db(), seed.teamId, passStartedAt, "nothing-to-score");

    /**
     * ⚠️ The property is "the failure stays NEWEST", not "the leg stays `failing`" — and the
     * difference is a real one this test corrected in the spec.
     *
     * The backdated row lands BETWEEN the old streak and the new failure, so the newest failure's
     * streak is 1 and `FAILURES_TO_CONFIRM` = 2 makes it `unconfirmed` — quiet by the SAME policy
     * that stops one blip painting the banner. That is not masking: the failure is still the newest
     * row and still `ok:false` on the leg, so the next failure re-confirms immediately. What
     * backdating guarantees is that the clearing row can never sit ON TOP of it and erase it.
     */
    const h = await getPipelineHealth(seed.teamId);
    const leg = h.legs.find((l) => l.source === DOC_TASK_INFER_SOURCE)!;
    expect(leg.ok, "the newest row must be the live FAILURE, not the clearing row").toBe(false);
    expect(leg.failureClass).toBe("unconfirmed");

    // …and it re-confirms on the very next failure, so the alarm is deferred by one run, not lost.
    await recordIngestRun(db(), {
      teamId: seed.teamId, source: DOC_TASK_INFER_SOURCE, trigger: "scheduler",
      ok: false, errors: ["every worker failed"], startedAt: Date.now(),
    });
    expect(await isFailing(seed)).toBe(true);
  });

  it("AC5 — without backdating the same interleaving DOES mask (the mechanism is load-bearing)", async () => {
    // The positive control for the test above: written at `now` instead of the pass start, the clearing
    // row wins the ordering and the real failure disappears from the banner. This is what the
    // backdating prevents, demonstrated rather than asserted.
    const seed = await seedTeam();
    await confirmedFailureStreak(seed);
    await recordIngestRun(db(), {
      teamId: seed.teamId, source: DOC_TASK_INFER_SOURCE, trigger: "scheduler",
      ok: false, errors: ["every worker failed"], startedAt: Date.now() - 1000,
    });
    await recordClearingRun(db(), seed.teamId, Date.now() + 1000, "nothing-to-score");

    expect(await isFailing(seed)).toBe(false);
  });

  it("AC3 — the steady state writes NOTHING: no standing failure, no clearing row", async () => {
    // This is the whole cooldown story. Because nothing is written when the verdict is already `ok`,
    // a clearing row can never become `lastRun` and defer the next real scoring pass.
    const seed = await seedTeam();
    await withModel(seed.teamId);
    await doc(seed);
    await run(seed, { ok: true, agoMs: PAST_COOLDOWN_MS });
    const n = await rowCount(seed);

    expect((await runDocTaskInference(db(), seed.teamId)).skipped).toBe("no-candidates");
    expect(await rowCount(seed), "healthy + idle must be silent").toBe(n);
  });

  it("AC7 — classification does not drift with age: 2 days and 60 days read the same", async () => {
    // BANNERFLAP-1 §3a rejected time-based escalation. A grace period here is the one fix already
    // known to be wrong, so the property is behavioural, not a source grep.
    const fresh = await seedTeam();
    await run(fresh, { ok: false, agoMs: 2 * 86_400_000 });
    await run(fresh, { ok: false, agoMs: 2 * 86_400_000 - 60_000 });

    const old = await seedTeam();
    await run(old, { ok: false, agoMs: 60 * 86_400_000 });
    await run(old, { ok: false, agoMs: 60 * 86_400_000 - 60_000 });

    expect(await isFailing(fresh)).toBe(await isFailing(old));
    expect(await isFailing(old)).toBe(true);
  });

  it("AC4 — a genuine failure is still loud, and `failingSince` reports the OLDEST in the streak", async () => {
    const seed = await seedTeam();
    await run(seed, { ok: false, agoMs: 3 * 86_400_000 });
    await run(seed, { ok: false, agoMs: 86_400_000 });

    const h = await getPipelineHealth(seed.teamId);
    const leg = h.legs.find((l) => l.source === DOC_TASK_INFER_SOURCE)!;
    expect(leg.failureClass).toBe("confirmed");
    expect(h.failing.some((l) => l.source === DOC_TASK_INFER_SOURCE)).toBe(true);
    // Not the newest — a leg failing for three days must not read "failing since 20 minutes ago".
    expect(Date.now() - Date.parse(leg.failingSince!)).toBeGreaterThan(2.5 * 86_400_000);
  });

  it("AC2e — a SATURATED item scan does not clear: the pass saw only part of the window", async () => {
    // `:206`/`:237`/`:270` are JS filters over ONE bounded page (`limit(ITEM_SCAN)`), so with a full
    // page "nothing to score" means "nothing in the newest 500" — item 501 can be unscored work.
    const seed = await seedTeam();
    await withModel(seed.teamId);
    const projectId = await project(seed);
    await task(seed, projectId);
    // 500 rows that FILL the page and are then dropped in JS by `isScoreableSource` (slack is
    // conversational). `member_id` must be a real member: the wide read excludes null owners in SQL
    // (`.not("member_id","is",null)`), so null-owner filler never reaches the page and the scan would
    // not saturate — the fixture would then prove nothing, which is how this first went green.
    const owner = await member(seed.teamId);
    const rows = Array.from({ length: 500 }, () => ({
      team_id: seed.teamId, project_id: projectId,
      kind: "artifact" as const, path: `x/${randomUUID()}.md`,
      access: "team" as const, body: "chatter", member_id: owner,
      content_sha256: randomUUID().replace(/-/g, ""),
      frontmatter: { source: "slack", title: "t", updated: recentIso },
      work_at: recentIso, work_at_from_source: true,
    }));
    const ins = await db().from("items").insert(rows);
    if (ins.error) throw new Error(`items insert failed: ${ins.error.message}`);
    const { data: got } = await db().from("items").select("id").eq("team_id", seed.teamId);
    expect((got ?? []).length, "the page must actually be full, or this proves nothing").toBeGreaterThanOrEqual(500);
    await confirmedFailureStreak(seed);
    const n = await rowCount(seed);

    const res = await runDocTaskInference(db(), seed.teamId);
    expect(res.skipped).toBe("nothing-to-score");
    expect(await rowCount(seed), "a saturated scan must abstain").toBe(n);
    expect(await isFailing(seed)).toBe(true);
  });
});
