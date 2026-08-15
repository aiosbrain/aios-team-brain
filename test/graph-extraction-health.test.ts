import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeName, ITEM_EPISODE_PREFIX } from "@/lib/graph/episode-name";
import { LANDED_GRACE_MS } from "@/lib/graph/reconcile";
import {
  deriveExtractionVerdict,
  extractionLagHours,
  extractionObservationNote,
  extractionStallReason,
  extractionStallShortText,
  parseProbeTimestamp,
  readExtractionSignals,
  EXTRACTION_LAG_BUDGET_MS,
  EXTRACTION_STALL_CAUSES,
  MIN_ITEMS_FOR_EXTRACTION_SIGNAL,
  type ExtractionLiveness,
  type ExtractionSignals,
  type ExtractionStallCause,
} from "@/lib/graph/extraction-health";

vi.mock("@/lib/db/pg/pool", () => ({ runSql: vi.fn() }));
vi.mock("@/lib/graph/neo4j", () => ({ neo4jConfigured: vi.fn(() => true), runRead: vi.fn() }));
import { runSql } from "@/lib/db/pg/pool";
import { neo4jConfigured, runRead } from "@/lib/graph/neo4j";

/**
 * THE STATE TABLE (STALLSCOPE-1 §2e).
 *
 * Three defects put this table here, and each cell is one of them:
 *
 *  1. The liveness read returned `number | null`, where `null` meant FIVE things — unconfigured, threw,
 *     unparseable, no scope, and "the read succeeded and found nothing". The predicate treated all five
 *     as "can't tell", so a team whose extraction has never once completed was silent.
 *  2. The fact count was GLOBAL, so on any install holding facts from anywhere else `facts === 0` was
 *     false forever and the never-extracted half was permanently disarmed for the broken team.
 *  3. The 25-item floor was standing in for a question about TIME, and it does not: measured on prod,
 *     the 25th real push landed **17 seconds** after the first, while extraction completes ~1 episode
 *     per minute — so a healthy fresh install was accused within a minute of its first ingest.
 *
 * The fix for (3) is NOT just a longer timer. The worker is serial, so a cold team can queue behind
 * another team's backlog (prod's own first ingest hour: 175 items ⇒ ~3h of queue) and no constant
 * bounds that. Hence the corroboration: a zero-evidence state goes LOUD only when the graph shows no
 * completion ANYWHERE inside the lag budget; while the worker is provably busy the same state is a
 * card observation instead. These cases pin both halves — an absence must be able to accuse, and it
 * must not accuse while the innocent explanation is still standing.
 */

const N = MIN_ITEMS_FOR_EXTRACTION_SIGNAL;
const NOW = 1_800_000_000_000;
/** `first_seen_at` old enough that the age gate has passed. */
const GATE_PASSED = NOW - LANDED_GRACE_MS - 1;
/** …and young enough that it has not (the fresh-install case). */
const GATE_OPEN = NOW - LANDED_GRACE_MS + 1;

const WORKER_BUSY: ExtractionLiveness = { kind: "at", atMs: NOW - 60_000 };
const WORKER_IDLE: ExtractionLiveness = { kind: "at", atMs: NOW - EXTRACTION_LAG_BUDGET_MS - 1 };
const WORKER_NEVER: ExtractionLiveness = { kind: "none" };
const WORKER_UNREADABLE: ExtractionLiveness = { kind: "unreadable" };

const FRESH_COMPLETION: ExtractionLiveness = { kind: "at", atMs: NOW - 120_000 };
const STALE_COMPLETION: ExtractionLiveness = {
  kind: "at",
  atMs: NOW - 60_000 - EXTRACTION_LAG_BUDGET_MS - 1,
};

/** A healthy team, from which each case moves exactly one thing. */
const sig = (over: Partial<ExtractionSignals> = {}): ExtractionSignals => ({
  items: N,
  firstSeenAtMs: GATE_PASSED,
  facts: 100,
  newestPushAtMs: NOW - 60_000,
  liveness: FRESH_COMPLETION,
  workerLiveness: WORKER_IDLE,
  nowMs: NOW,
  ...over,
});

type Expected = {
  stalled: boolean;
  cause: ExtractionStallCause | null;
  observed: "queued-behind-worker" | null;
};

const CASES: { name: string; over: Partial<ExtractionSignals>; want: Expected }[] = [
  // ── liveness `unreadable` ───────────────────────────────────────────────────────────────────────
  {
    name: "unreadable liveness + 0 facts + gate passed + idle worker ⇒ no-facts (a definitive zero still accuses)",
    over: { liveness: WORKER_UNREADABLE, facts: 0 },
    want: { stalled: true, cause: "no-facts", observed: null },
  },
  {
    name: "unreadable liveness + 0 facts + busy worker ⇒ observation, not an alarm",
    over: { liveness: WORKER_UNREADABLE, facts: 0, workerLiveness: WORKER_BUSY },
    want: { stalled: false, cause: null, observed: "queued-behind-worker" },
  },
  {
    name: "unreadable liveness + 0 facts + gate NOT passed ⇒ silent (the fresh-install window)",
    over: { liveness: WORKER_UNREADABLE, facts: 0, firstSeenAtMs: GATE_OPEN },
    want: { stalled: false, cause: null, observed: null },
  },
  {
    name: "unreadable liveness + facts > 0 ⇒ silent: it cannot accuse by itself",
    over: { liveness: WORKER_UNREADABLE },
    want: { stalled: false, cause: null, observed: null },
  },
  {
    name: "unreadable liveness + unreadable facts ⇒ silent",
    over: { liveness: WORKER_UNREADABLE, facts: null },
    want: { stalled: false, cause: null, observed: null },
  },
  // ── liveness `none` — the read SUCCEEDED and found nothing ──────────────────────────────────────
  {
    name: "none + 0 facts + idle worker ⇒ no-facts (the stronger claim wins the cause)",
    over: { liveness: WORKER_NEVER, facts: 0 },
    want: { stalled: true, cause: "no-facts", observed: null },
  },
  {
    name: "none + facts > 0 + idle worker ⇒ no-completion-visible (correction episodes make facts without a ledger row)",
    over: { liveness: WORKER_NEVER },
    want: { stalled: true, cause: "no-completion-visible", observed: null },
  },
  {
    name: "none + unreadable facts + idle worker ⇒ no-completion-visible (draft 2 left this cell with a NULL cause, which renders an empty red banner)",
    over: { liveness: WORKER_NEVER, facts: null },
    want: { stalled: true, cause: "no-completion-visible", observed: null },
  },
  {
    name: "none + busy worker ⇒ observation: a serial worker on someone else's backlog is why this happens",
    over: { liveness: WORKER_NEVER, workerLiveness: WORKER_BUSY },
    want: { stalled: false, cause: null, observed: "queued-behind-worker" },
  },
  {
    name: "none + gate NOT passed ⇒ silent, even with an idle worker",
    over: { liveness: WORKER_NEVER, firstSeenAtMs: GATE_OPEN },
    want: { stalled: false, cause: null, observed: null },
  },
  {
    name: "none + a worker whose own clock is unreadable ⇒ accuses: suppression needs POSITIVE evidence",
    over: { liveness: WORKER_NEVER, workerLiveness: WORKER_UNREADABLE },
    want: { stalled: true, cause: "no-completion-visible", observed: null },
  },
  {
    name: "none + a worker that has never completed anything anywhere ⇒ accuses",
    over: { liveness: WORKER_NEVER, workerLiveness: WORKER_NEVER },
    want: { stalled: true, cause: "no-completion-visible", observed: null },
  },
  {
    // MUTATION-FOUND GAP: deleting the skew bound left every test green. A suppressor with no upper
    // bound on clock skew can mute an alarm for as long as the stamp stays in the future — the
    // "quietly declines to fire" failure this family exists to remove. Small skew (seconds) must still
    // count as evidence, so the tolerance is a bound, not a ban.
    name: "none + a worker stamp FAR in the future ⇒ accuses (a wrong clock cannot mute an alarm)",
    over: {
      liveness: WORKER_NEVER,
      workerLiveness: { kind: "at", atMs: NOW + 2 * 3_600_000 },
    },
    want: { stalled: true, cause: "no-completion-visible", observed: null },
  },
  {
    name: "none + a worker stamp seconds ahead ⇒ still suppresses (ordinary container skew)",
    over: { liveness: WORKER_NEVER, workerLiveness: { kind: "at", atMs: NOW + 30_000 } },
    want: { stalled: false, cause: null, observed: "queued-behind-worker" },
  },
  // ── liveness `at`, inside the lag budget ────────────────────────────────────────────────────────
  {
    name: "at + 0 facts + idle worker ⇒ no-facts (jobs complete, nothing is extracted)",
    over: { facts: 0 },
    want: { stalled: true, cause: "no-facts", observed: null },
  },
  {
    // THE REGRESSION REVIEW CAUGHT. The first version of the corroboration applied to every
    // zero-evidence cell, and because the worker read was an un-scoped SUPERSET of the team's own
    // liveness, `workerBusy` was true BY CONSTRUCTION whenever this cell was reachable — so a live
    // zero-yield extractor (jobs completing for this team, zero facts ever) silently became a note.
    // `origin/main` kept it loud on purpose: "an extractor that runs to completion and still produces
    // zero facts IS broken". Queue depth cannot explain a team whose own jobs are completing.
    name: "at + 0 facts + a busy worker is STILL loud — the team's own completions disprove queue depth",
    over: { facts: 0, workerLiveness: WORKER_BUSY },
    want: { stalled: true, cause: "no-facts", observed: null },
  },
  {
    name: "at + 0 facts + gate NOT passed ⇒ silent",
    over: { facts: 0, firstSeenAtMs: GATE_OPEN },
    want: { stalled: false, cause: null, observed: null },
  },
  {
    name: "at + facts > 0 + fresh completion ⇒ healthy (the whole point of STALLPROBE-1)",
    over: {},
    want: { stalled: false, cause: null, observed: null },
  },
  {
    name: "at + unreadable facts + fresh completion ⇒ healthy",
    over: { facts: null },
    want: { stalled: false, cause: null, observed: null },
  },
  // ── liveness `at`, past the lag budget ──────────────────────────────────────────────────────────
  {
    name: "at + facts > 0 + stale completion ⇒ stopped",
    over: { liveness: STALE_COMPLETION },
    want: { stalled: true, cause: "stopped", observed: null },
  },
  {
    name: "at + unreadable facts + stale completion ⇒ stopped (the copy must not print a count it lacks)",
    over: { liveness: STALE_COMPLETION, facts: null },
    want: { stalled: true, cause: "stopped", observed: null },
  },
  {
    name: "stale completion + a BUSY worker is still stopped — the lag branch is never suppressed",
    over: { liveness: STALE_COMPLETION, workerLiveness: WORKER_BUSY },
    want: { stalled: true, cause: "stopped", observed: null },
  },
  {
    name: "stale completion + gate NOT passed is still stopped — the lag branch is never gated",
    over: { liveness: STALE_COMPLETION, firstSeenAtMs: GATE_OPEN },
    want: { stalled: true, cause: "stopped", observed: null },
  },
  {
    name: "stale completion + 0 facts ⇒ no-facts takes precedence over stopped",
    over: { liveness: STALE_COMPLETION, facts: 0 },
    want: { stalled: true, cause: "no-facts", observed: null },
  },
];

describe("deriveExtractionVerdict — every cell of the state table", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(deriveExtractionVerdict(sig(c.over))).toEqual(c.want);
    });
  }

  it("a stalled verdict ALWAYS carries a cause, over the whole table", () => {
    // Not per-case: a `stalled: true` with a null cause reaches `lib/query/retrieval-health` (which maps
    // it to a null reason and renders an EMPTY red paragraph) and `lib/ingest/pipeline-health` (which
    // pushes a `graph_extract` leg with `error: null`). Draft 2 of the spec had exactly that hole.
    for (const c of CASES) {
      const v = deriveExtractionVerdict(sig(c.over));
      if (v.stalled) expect(v.cause, c.name).not.toBeNull();
      if (!v.stalled) expect(v.cause, c.name).toBeNull();
      // …and the two outputs are mutually exclusive: an alarm and a "nothing to worry about" note must
      // never render together.
      if (v.observed !== null) expect(v.stalled, c.name).toBe(false);
    }
  });

  it("every stalled cell produces a non-empty reason string", () => {
    for (const c of CASES) {
      const s = sig(c.over);
      const v = deriveExtractionVerdict(s);
      if (!v.cause) continue;
      const reason = extractionStallReason(v.cause, {
        items: s.items,
        facts: s.facts,
        lagHours: extractionLagHours(s.newestPushAtMs, s.liveness),
        liveness: s.liveness,
      });
      expect(reason.length, c.name).toBeGreaterThan(80);
    }
  });
});

describe("the floor — defect (c)'s protection, and the reason it is not enough on its own", () => {
  it("below the floor nothing is emitted at all, not even an observation", () => {
    for (const items of [0, 1, N - 1]) {
      expect(
        deriveExtractionVerdict(sig({ items, facts: 0, liveness: WORKER_NEVER })),
        `items=${items}`
      ).toEqual({ stalled: false, cause: null, observed: null });
    }
  });

  it("an unreadable ledger (items null) never accuses — it is an absence of evidence about everything", () => {
    expect(deriveExtractionVerdict(sig({ items: null, facts: 0, liveness: WORKER_NEVER }))).toEqual({
      stalled: false,
      cause: null,
      observed: null,
    });
  });

  it("THE MEASURED FRESH-INSTALL CASE: 25 items 17 seconds in, zero facts, healthy ⇒ silent", () => {
    // Prod's own numbers: the 25th real push landed 17s after the first, and extraction completes about
    // one episode a minute. Before this slice that state returned `stalled: true` with the sentence
    // "Graphiti is accepting episodes (202) yet its entity-extraction worker is failing on every job"
    // — on a perfectly healthy install, on the loud banner, during someone's first ingest.
    expect(
      deriveExtractionVerdict(
        sig({
          items: N,
          facts: 0,
          firstSeenAtMs: NOW - 17_000,
          liveness: WORKER_NEVER,
          workerLiveness: WORKER_NEVER,
          newestPushAtMs: NOW - 1_000,
        })
      )
    ).toEqual({ stalled: false, cause: null, observed: null });
  });

  it("…and the same install once the grace has passed and nothing has completed ⇒ loud", () => {
    expect(
      deriveExtractionVerdict(
        sig({
          items: N,
          facts: 0,
          firstSeenAtMs: NOW - LANDED_GRACE_MS - 1,
          liveness: WORKER_NEVER,
          workerLiveness: WORKER_NEVER,
        })
      )
    ).toEqual({ stalled: true, cause: "no-facts", observed: null });
  });
});

describe("the age gate boundary — an imported grace, exercised at the edge", () => {
  // A NAME-ONLY import satisfies nothing: these three cases fail if the gate uses any other constant,
  // and the import is what keeps this file and `lib/graph/reconcile` from drifting apart.
  const at = (firstSeenAtMs: number) =>
    deriveExtractionVerdict(sig({ facts: 0, liveness: WORKER_NEVER, firstSeenAtMs })).stalled;

  it("is exclusive: exactly at the grace is silent, one ms past accuses", () => {
    expect(at(NOW - LANDED_GRACE_MS + 1)).toBe(false);
    expect(at(NOW - LANDED_GRACE_MS)).toBe(false);
    expect(at(NOW - LANDED_GRACE_MS - 1)).toBe(true);
  });

  it("a null clock never manufactures a stall (a row predating the column, or an unreadable ledger)", () => {
    expect(at(NaN)).toBe(false);
    expect(
      deriveExtractionVerdict(sig({ facts: 0, liveness: WORKER_NEVER, firstSeenAtMs: null })).stalled
    ).toBe(false);
  });

  it("…but a null clock does NOT suppress the lag branch, which measures from a real completion", () => {
    expect(
      deriveExtractionVerdict(sig({ firstSeenAtMs: null, liveness: STALE_COMPLETION })).cause
    ).toBe("stopped");
  });
});

describe("the lag budget boundary (STALLPROBE-1's contract, preserved)", () => {
  const base = { items: 1243, facts: 400, newestPushAtMs: NOW };
  it("is exclusive: exactly at budget is healthy, one ms past is stalled", () => {
    expect(
      deriveExtractionVerdict(
        sig({ ...base, liveness: { kind: "at", atMs: NOW - EXTRACTION_LAG_BUDGET_MS } })
      ).stalled
    ).toBe(false);
    expect(
      deriveExtractionVerdict(
        sig({ ...base, liveness: { kind: "at", atMs: NOW - EXTRACTION_LAG_BUDGET_MS - 1 } })
      ).stalled
    ).toBe(true);
  });

  it("a completion NEWER than the newest push is healthy, not negative-lag nonsense", () => {
    expect(
      deriveExtractionVerdict(sig({ ...base, liveness: { kind: "at", atMs: NOW + 60_000 } })).stalled
    ).toBe(false);
  });

  it("stale FACTS with a live completion are NOT a stall — the false positive this family removed", () => {
    // The dedup-frozen graph: prod runs ~6.6 `dedupe_edges` per `extract_edges`, so most extracted
    // edges create no new RELATES_TO and the fact clock freezes while extraction works perfectly.
    expect(
      deriveExtractionVerdict(
        sig({ ...base, newestFactAtMs: NOW - 30 * 86_400_000, liveness: FRESH_COMPLETION })
      )
    ).toEqual({ stalled: false, cause: null, observed: null });
  });

  it("a null newest-push never accuses through the lag branch", () => {
    expect(
      deriveExtractionVerdict(sig({ newestPushAtMs: null, liveness: STALE_COMPLETION })).stalled
    ).toBe(false);
  });
});

describe("extractionStallReason — what each cause is allowed to claim", () => {
  const args = (over: Partial<Parameters<typeof extractionStallReason>[1]> = {}) => ({
    items: 30,
    facts: 0,
    lagHours: 9,
    liveness: WORKER_NEVER as ExtractionLiveness,
    ...over,
  });

  it("no-facts states the zero and nothing about completions except what liveness says", () => {
    const never = extractionStallReason("no-facts", args({ liveness: { kind: "none" } }));
    expect(never).toContain("0 extracted facts");
    expect(never).toContain("no completed episode");

    const completing = extractionStallReason(
      "no-facts",
      args({ liveness: { kind: "at", atMs: NOW }, lagHours: 1 })
    );
    expect(completing).toContain("Jobs ARE completing");

    // …and the clause is RECENCY-aware. `no-facts` outranks the lag branch, so this cause is reachable
    // with a completion OLDER than the budget — where "jobs are completing" would be false (review).
    const staleCompletion = extractionStallReason(
      "no-facts",
      args({ liveness: { kind: "at", atMs: NOW }, lagHours: 30 })
    );
    expect(staleCompletion).not.toContain("Jobs ARE completing");
    expect(staleCompletion).toContain("30h behind");

    const unknown = extractionStallReason("no-facts", args({ liveness: { kind: "unreadable" } }));
    expect(unknown).toContain("could not be read");
  });

  it("no-facts offers causes without asserting that a regression occurred", () => {
    const r = extractionStallReason("no-facts", args());
    expect(r).toContain("none of them yet established");
    // The old copy asserted one: "its entity-extraction worker is failing on every job".
    expect(r).not.toContain("failing on every job");
  });

  it("no-completion-visible names the graph-store restore and the RATE it self-heals at", () => {
    // The first version asserted the copy said a wipe is PERMANENT because "the ledger's content
    // hashes suppress re-pushing". Both reviewers showed that is FALSE — `lib/graph/reconcile.ts`
    // re-queues never-landed rows and the projector re-pushes them — and this assertion was
    // build-ENFORCING the falsehood, which is worse than the sentence alone.
    const r = extractionStallReason("no-completion-visible", args({ facts: 4200 }));
    expect(r).toContain("wipe or restore");
    expect(r).toContain("self-heal");
    expect(r).toContain("drip rate");
    expect(r).not.toContain("PERMANENT");
    // It must also explain why facts can exist while nothing has completed for the items.
    expect(r).toContain("arc corrections");
    expect(r).toContain("4200 facts");
  });

  it("never prints a fact count it does not have — on any cause", () => {
    for (const cause of ["no-facts", "no-completion-visible", "stopped"] as ExtractionStallCause[]) {
      const r = extractionStallReason(cause, args({ facts: null }));
      expect(r, cause).not.toMatch(/holds null|null facts|holds 0 facts/);
    }
    expect(extractionStallReason("no-completion-visible", args({ facts: null }))).toContain("unreadable");
  });

  it("stopped degrades to 'for some time' rather than printing 'nullh'", () => {
    const r = extractionStallReason("stopped", args({ facts: 12, lagHours: null }));
    expect(r).toContain("for some time");
    expect(r).not.toContain("null");
  });

  it("no reason string leaks a group_id — the copy says 'this team's graph groups'", () => {
    // Tier safety, pinned rather than trusted (§ Tier safety). The census table on the same card DOES
    // render per-group rows; this is scoped to the stall copy, which has no reason to print a partition
    // key and would be the first place one leaked into a sentence an operator screenshots.
    const groupish = /\b[a-z0-9-]+_(team|external)\b|\bg_[0-9a-f]+_p_[0-9a-f]+\b/;
    for (const cause of ["no-facts", "no-completion-visible", "stopped"] as ExtractionStallCause[]) {
      expect(extractionStallReason(cause, args({ facts: 7 })), cause).not.toMatch(groupish);
    }
    expect(extractionObservationNote(30)).not.toMatch(groupish);
  });

  it("EVERY cause has its own sentence — iterated at runtime, not enforced by an annotation", () => {
    // MUTATION-FOUND GAP. The card's copy map is typed `Record<ExtractionStallCause, …>`, which does
    // redden `tsc` when an entry is DELETED — but swapping the annotation for `Record<string, …>` and
    // adding a fourth cause compiles clean, and the new cause silently renders the `stopped` wording.
    // That is "the guard is satisfiable by editing the guard", which two reviewers found in LLMOBS-1
    // and a mutation found here. `EXTRACTION_STALL_CAUSES` exists so this can be checked at runtime:
    // add a cause without giving it copy and these assertions fail whatever the types say.
    const short = EXTRACTION_STALL_CAUSES.map((c) => extractionStallShortText(c, { lagHours: 3 }));
    const long = EXTRACTION_STALL_CAUSES.map((c) =>
      extractionStallReason(c, { items: 30, facts: 0, lagHours: 3, liveness: WORKER_NEVER })
    );
    expect(new Set(short).size, "two causes share one short text").toBe(EXTRACTION_STALL_CAUSES.length);
    expect(new Set(long).size, "two causes share one reason").toBe(EXTRACTION_STALL_CAUSES.length);
    for (const s of [...short, ...long]) expect(s.length).toBeGreaterThan(20);
    // …and the enumeration is the real one, not a stale copy of it.
    expect([...EXTRACTION_STALL_CAUSES].sort()).toEqual(["no-completion-visible", "no-facts", "stopped"]);
  });

  it("the observation says what it is and does not accuse", () => {
    const note = extractionObservationNote(30);
    expect(note).toContain("30 items");
    expect(note).toContain("queue depth");
    expect(note).not.toMatch(/broken|failing|STOPPED/);
  });
});

describe("extractionLagHours", () => {
  it("is null unless BOTH ends are known", () => {
    expect(extractionLagHours(null, { kind: "at", atMs: 1_000 })).toBeNull();
    expect(extractionLagHours(1_000, { kind: "none" })).toBeNull();
    expect(extractionLagHours(1_000, { kind: "unreadable" })).toBeNull();
  });

  it("rounds to whole hours and keeps the sign", () => {
    expect(extractionLagHours(NOW, { kind: "at", atMs: NOW - 9 * 3_600_000 })).toBe(9);
    // Clock skew reads negative rather than being clamped: a negative lag is healthy, and clamping
    // would hide a clock problem rather than show it.
    expect(extractionLagHours(NOW, { kind: "at", atMs: NOW + 3_600_000 })).toBe(-1);
  });
});

/**
 * The parsing seam. Two producers, no compiler between them: Postgres `timestamptz::text` and Neo4j
 * `toString(datetime)`. If either format shifts, the recency check disarms itself silently while every
 * other test here stays green — the exact class of bug this file was rewritten to fix. So the real
 * wire formats are pinned rather than assumed.
 */
describe("parseProbeTimestamp — the formats the two probes actually emit", () => {
  it("parses Postgres timestamptz::text, with any offset", () => {
    expect(parseProbeTimestamp("2026-07-28 12:34:56.789+00")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
    expect(parseProbeTimestamp("2026-07-28 05:34:56.789-07")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
    expect(parseProbeTimestamp("2026-07-28 18:04:56.789+05:30")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
  });

  it("parses Neo4j toString(datetime), including nanosecond precision", () => {
    expect(parseProbeTimestamp("2026-07-28T12:34:56.789000000Z")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
    expect(parseProbeTimestamp("2026-07-28T12:34:56.789+00:00")).toBe(Date.parse("2026-07-28T12:34:56.789Z"));
  });

  it("returns null — never NaN — for absent or unparseable input", () => {
    // A bracketed named zone is the realistic future break (a Neo4j upgrade could emit it); it must
    // read as "don't know", which disarms the check, not as a bogus epoch that fabricates a stall.
    expect(parseProbeTimestamp("2026-07-28T12:34:56+01:00[Europe/London]")).toBeNull();
    expect(parseProbeTimestamp(null)).toBeNull();
    expect(parseProbeTimestamp(undefined)).toBeNull();
    expect(parseProbeTimestamp("")).toBeNull();
    expect(parseProbeTimestamp("not a date")).toBeNull();
  });
});

/**
 * THE READS, through the producer — because the discrimination this slice adds lives in the seam
 * between a query answering and a query failing, and no pure test can reach it.
 */
describe("readExtractionSignals — 'found nothing' vs 'could not read'", () => {
  const ledgerRow = (over: Record<string, unknown> = {}) => ({
    rows: [
      {
        items: 30,
        first_seen_at: new Date(NOW - 86_400_000).toISOString(),
        newest_push_at: new Date(NOW - 60_000).toISOString(),
        groups: ["acme_team"],
        ...over,
      },
    ],
  });

  beforeEach(() => {
    vi.mocked(neo4jConfigured).mockReturnValue(true);
    vi.mocked(runSql).mockReset();
    vi.mocked(runRead).mockReset();
  });

  it("reads the ledger in ONE statement — the property the dm tier cannot observe", () => {
    // Two concurrent reads (a count and a distinct-group scan) could return `items > 0` with
    // `groups: []`: a team that looks pushed-but-unscoped, which is exactly the shape that decides
    // whether an absence of graph evidence may accuse. Spied here because a data-mechanics test sees
    // only results, and four sequential queries return the same fixture as one.
    vi.mocked(runSql).mockResolvedValue(ledgerRow() as never);
    vi.mocked(runRead).mockResolvedValue([{ n: 5, at: null }] as never);
    return readExtractionSignals("t1", NOW).then(() => {
      expect(vi.mocked(runSql)).toHaveBeenCalledTimes(1);
      const sqlText = String(vi.mocked(runSql).mock.calls[0]?.[0]);
      expect(sqlText).toContain("count(distinct (source_table, source_id))");
      expect(sqlText).toContain("min(first_seen_at)");
      expect(sqlText).toContain("max(projected_at)");
      expect(sqlText).toContain("array_agg(distinct group_id)");
      expect(sqlText).toContain("content_sha256 <> ''");
    });
  });

  it("a graph read that ANSWERS with no rows is `none`, and it can accuse", async () => {
    vi.mocked(runSql).mockResolvedValue(
      ledgerRow({ first_seen_at: new Date(NOW - LANDED_GRACE_MS - 1000).toISOString() }) as never
    );
    // facts: a real 0; liveness + worker: `max()` over an empty set.
    vi.mocked(runRead).mockResolvedValue([{ n: 0, at: null }] as never);
    const reading = await readExtractionSignals("t1", NOW);
    expect(reading.signals.liveness).toEqual({ kind: "none" });
    expect(reading.signals.facts).toBe(0);
    expect(reading.verdict).toEqual({ stalled: true, cause: "no-facts", observed: null });
    expect(reading.reason).toContain("0 extracted facts");
  });

  it("the fact read is SCOPED to this team's groups — the half that fixes the global count", async () => {
    // MUTATION-FOUND GAP: dropping `WHERE r.group_id IN $g` reverts defect (b) — the count goes global,
    // `facts === 0` becomes false forever on any install holding facts from anywhere else, and the
    // never-extracted half is permanently disarmed for the team that is broken. Every other test in
    // this file stayed green under that mutation, because they all mock the read. So the SCOPE is
    // pinned at the call, not just the text: the query must carry the filter AND be handed this team's
    // ledger groups as its parameter.
    vi.mocked(runSql).mockResolvedValue(ledgerRow({ groups: ["acme_team", "acme_external"] }) as never);
    vi.mocked(runRead).mockResolvedValue([{ n: 7, at: null }] as never);
    await readExtractionSignals("t1", NOW);
    const factCall = vi.mocked(runRead).mock.calls.find((c) => String(c[0]).includes("RELATES_TO"));
    expect(factCall, "the fact read is gone — this test is stale, not passing").toBeDefined();
    expect(String(factCall![0])).toContain("r.group_id IN $g");
    expect(factCall![1]).toEqual({ g: ["acme_team", "acme_external"] });
    // …and the liveness read is scoped to the SAME population, since one is subtracted from the other.
    const liveCall = vi.mocked(runRead).mock.calls.find((c) => String(c[0]).includes("(e:Episodic)"));
    expect((liveCall![1] as { g: string[] }).g).toEqual(["acme_team", "acme_external"]);
  });

  it("a graph read that THROWS is `unreadable`, and it cannot", async () => {
    vi.mocked(runSql).mockResolvedValue(
      ledgerRow({ first_seen_at: new Date(NOW - LANDED_GRACE_MS - 1000).toISOString() }) as never
    );
    vi.mocked(runRead).mockRejectedValue(new Error("neo4j: connection acquisition timed out"));
    const reading = await readExtractionSignals("t1", NOW);
    expect(reading.signals.liveness).toEqual({ kind: "unreadable" });
    expect(reading.signals.facts).toBeNull();
    expect(reading.verdict.stalled).toBe(false);
    expect(reading.reason).toBeNull();
  });

  it("NO SCOPE ⇒ no graph query is issued at all, and nothing accuses", async () => {
    // An `IN []` match returns a genuine `0`, which would read as a proven-empty graph. The team-scoped
    // reads must not run; the GLOBAL worker read still may, since it has no scope to lack.
    vi.mocked(runSql).mockResolvedValue({ rows: [{ items: 0, first_seen_at: null, newest_push_at: null, groups: null }] } as never);
    vi.mocked(runRead).mockResolvedValue([{ at: null }] as never);
    const reading = await readExtractionSignals("t1", NOW);
    expect(reading.signals.items).toBe(0);
    expect(reading.signals.facts).toBeNull();
    expect(reading.signals.liveness).toEqual({ kind: "unreadable" });
    // exactly one Neo4j call: the un-scoped worker clock
    expect(vi.mocked(runRead)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(runRead).mock.calls[0]?.[0])).toContain("(w:Episodic)");
    expect(reading.verdict.stalled).toBe(false);
  });

  it("an unreadable LEDGER reports items null, never 0 — a zero here would read as a measurement", async () => {
    vi.mocked(runSql).mockRejectedValue(new Error("pg: terminating connection"));
    vi.mocked(runRead).mockResolvedValue([{ at: null }] as never);
    const reading = await readExtractionSignals("t1", NOW);
    expect(reading.signals.items).toBeNull();
    expect(reading.verdict.stalled).toBe(false);
  });

  it("an unconfigured graph issues no Neo4j read and stays quiet", async () => {
    vi.mocked(neo4jConfigured).mockReturnValue(false);
    vi.mocked(runSql).mockResolvedValue(ledgerRow() as never);
    const reading = await readExtractionSignals("t1", NOW);
    expect(vi.mocked(runRead)).not.toHaveBeenCalled();
    expect(reading.signals.liveness).toEqual({ kind: "unreadable" });
    expect(reading.verdict.stalled).toBe(false);
  });

  it("an unparseable stamp is `unreadable`, not a fabricated instant", async () => {
    vi.mocked(runSql).mockResolvedValue(ledgerRow() as never);
    vi.mocked(runRead).mockResolvedValue([{ n: 3, at: "2026-07-28T12:34:56+01:00[Europe/London]" }] as never);
    const reading = await readExtractionSignals("t1", NOW);
    expect(reading.signals.liveness).toEqual({ kind: "unreadable" });
  });
});

/**
 * THE LIVENESS READ'S POPULATION (STALLPROBE-1, round-4 review).
 *
 * The team-scoped liveness is SUBTRACTED FROM the newest push, so the two must count the same
 * episodes. Two review rounds found two ways they did not:
 *   • by GROUP — a global read let another team's completed job refresh this team's clock;
 *   • by KIND — a group-scoped read still counted `correction:<arc_id>` episodes, which
 *     `lib/graph/arcs.ts` POSTs into the same team group with NO `graph_episodes` row. An admin
 *     recomputing an arc mid-outage would have refreshed the clock and silenced the alarm for the
 *     whole 6h budget while every item episode was failing.
 */
describe("the liveness read counts ledger-backed item episodes only", () => {
  it("shares its prefix with the projector's episode names — one constant, not two literals", () => {
    expect(episodeName("abc", 0, 1)).toBe(`${ITEM_EPISODE_PREFIX}abc`);
    expect(episodeName("abc", 2, 5)).toBe(`${ITEM_EPISODE_PREFIX}abc#2`);
  });

  it("excludes the arc-correction writeback, which has no ledger row behind it", () => {
    expect(`correction:${"arc-8144f88eb1"}`.startsWith(ITEM_EPISODE_PREFIX)).toBe(false);
    expect(episodeName("i1", 0, 1).startsWith(ITEM_EPISODE_PREFIX)).toBe(true);
    expect(episodeName("i1", 1, 3).startsWith(ITEM_EPISODE_PREFIX)).toBe(true);
  });

  it("the query text actually applies that filter — the wiring, not just the constant", () => {
    // A source-level pin because the filter lives in a Cypher string: the two unit assertions above
    // stay green if someone deletes the `STARTS WITH` clause, which is exactly the bug.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "graph", "extraction-health.ts"),
      "utf8"
    );
    // Anchored on the opening QUOTE of the string literal, not on the bare text: the file's own
    // comments discuss `MATCH (e:Episodic)` at length, and a looser anchor matched the prose and
    // passed for the wrong reason on the first run.
    const start = src.indexOf('"MATCH (e:Episodic)');
    expect(start, "the liveness query literal is gone or was renamed").toBeGreaterThan(-1);
    const query = src.slice(start, src.indexOf('"', start + 1) + 1);
    expect(query).toContain("e.group_id IN $g");
    expect(query).toContain("e.name STARTS WITH $p");
  });

  it("the QUEUE corroborator excludes this team's groups AND non-ledger episodes", () => {
    // The first version pinned only "un-scoped + max", which was green by construction for the two
    // defects review then found: (1) an un-filtered global max is a SUPERSET of the team's own clock,
    // so "the worker is busy" was true whenever the team had a recent completion — silently turning a
    // live zero-yield extractor into a note; (2) one `correction:<arc_id>` episode, which has no ledger
    // row and which the TEAM clock already had to exclude for exactly this reason, would suppress the
    // alarm for the whole budget. Both are query-text properties, so they are pinned as query text.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "graph", "extraction-health.ts"),
      "utf8"
    );
    const start = src.indexOf('"MATCH (w:Episodic)');
    expect(start, "the worker-liveness query literal is gone or was renamed").toBeGreaterThan(-1);
    const query = src.slice(start, src.indexOf('"', start + 1) + 1);
    expect(query).toContain("NOT w.group_id IN $g"); // everyone ELSE
    expect(query).toContain("w.name STARTS WITH $p"); // ledger-backed item episodes only
    expect(query).toContain("max(w.created_at)");
  });

  it("…and the corroborator is handed the team's OWN groups as the exclusion", async () => {
    // The text above cannot prove the parameter is the right set. Deleting the argument or passing an
    // empty array restores the superset behaviour with the query text untouched.
    vi.mocked(runSql).mockResolvedValue(
      { rows: [{ items: 30, first_seen_at: new Date(NOW - 86_400_000).toISOString(), newest_push_at: new Date(NOW).toISOString(), last_projected_at: new Date(NOW).toISOString(), groups: ["acme_team"] }] } as never
    );
    vi.mocked(runRead).mockResolvedValue([{ n: 1, at: null }] as never);
    vi.mocked(neo4jConfigured).mockReturnValue(true);
    await readExtractionSignals("t1", NOW);
    const workerCall = vi.mocked(runRead).mock.calls.find((c) => String(c[0]).includes("(w:Episodic)"));
    expect(workerCall, "the corroborator never ran").toBeDefined();
    expect(workerCall![1]).toEqual({ g: ["acme_team"], p: ITEM_EPISODE_PREFIX });
  });
});
