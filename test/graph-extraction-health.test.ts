import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeName, ITEM_EPISODE_PREFIX } from "@/lib/graph/episode-name";
import {
  deriveGraphExtractionStalled,
  extractionLagHours,
  extractionStallCause,
  extractionStallReason,
  parseProbeTimestamp,
  EXTRACTION_LAG_BUDGET_MS,
  MIN_EPISODES_FOR_EXTRACTION_SIGNAL,
} from "@/lib/graph/extraction-health";

/**
 * The exact prod failure (2026-07): the projector POSTs episodes, Graphiti returns 202 and records
 * graph_project=OK, then its extractor fails every job ("Output length exceeded max tokens 8192") so
 * NO facts get created. `graph_project` stays green, /healthcheck stays green — the only observable
 * signal is "many episodes projected, zero facts extracted". This is that spec.
 */
describe("deriveGraphExtractionStalled", () => {
  const N = MIN_EPISODES_FOR_EXTRACTION_SIGNAL;

  it("STALLED: a real backlog of projected episodes but zero extracted facts (the live bug)", () => {
    expect(deriveGraphExtractionStalled({ episodes: 1243, facts: 0 })).toBe(true);
    expect(deriveGraphExtractionStalled({ episodes: N, facts: 0 })).toBe(true);
  });

  it("healthy: episodes projected AND facts exist — the extractor is working", () => {
    expect(deriveGraphExtractionStalled({ episodes: 1243, facts: 400 })).toBe(false);
    expect(deriveGraphExtractionStalled({ episodes: N, facts: 1 })).toBe(false);
  });

  it("not flagged below the threshold — a fresh install may still be mid-first-extraction", () => {
    // Too few episodes to distinguish "broken" from "Graphiti still processing the first batch".
    expect(deriveGraphExtractionStalled({ episodes: N - 1, facts: 0 })).toBe(false);
    expect(deriveGraphExtractionStalled({ episodes: 5, facts: 0 })).toBe(false);
  });

  it("nothing projected yet ⇒ not stalled (zero-vs-zero is a fresh graph, not a failure)", () => {
    expect(deriveGraphExtractionStalled({ episodes: 0, facts: 0 })).toBe(false);
  });

  it("unknown facts (Neo4j unreadable) ⇒ not stalled — reachability is a different leg's concern", () => {
    expect(deriveGraphExtractionStalled({ episodes: 1243, facts: null })).toBe(false);
  });

  it("unknown episodes (ledger unreadable) ⇒ not stalled — can't tell", () => {
    expect(deriveGraphExtractionStalled({ episodes: null, facts: 0 })).toBe(false);
    expect(deriveGraphExtractionStalled({ episodes: null, facts: null })).toBe(false);
  });
});

/**
 * The SECOND prod failure (2026-07-28), which the spec above could not see.
 *
 * Graphiti's extraction key hit `insufficient_quota`. Every episode failed extraction — but the
 * graph already held ~weeks of facts from before the key ran dry, so `facts === 0` was false and
 * the probe stayed silent. Admin → Integrations showed the graph leg **green** while extraction had
 * been dead for hours; it was found by reading the service logs, not the dashboard.
 *
 * The bug in the detector is a category error: it asks "did extraction EVER work?" when the question
 * an operator needs answered is "is extraction working NOW?". A non-zero historical fact count
 * answers the first question forever, so the check disarms itself the moment it has ever succeeded.
 *
 * The signal that separates them is RECENCY: episodes keep landing while no new fact appears.
 */
describe("deriveGraphExtractionStalled — extraction that STOPPED, not extraction that never started", () => {
  const N = MIN_EPISODES_FOR_EXTRACTION_SIGNAL;
  const HOUR = 3_600_000;
  const now = Date.parse("2026-07-28T12:00:00Z");
  const at = (hoursAgo: number) => now - hoursAgo * HOUR;

  // CONTRACT CHANGE (STALLPROBE-1). This block was written when FACT age was the accuser. It no
  // longer is: on a mature graph most extracted edges deduplicate, so the fact clock freezes while
  // extraction runs perfectly — that is the false positive this slice removes. The liveness question
  // is now "did a JOB FINISH" (`Episodic.created_at`), and fact age is observational. The 2026-07-28
  // outage these tests were written for is still caught, by the episodic clock instead.
  it("STALLED: episodes arriving, and NO JOB HAS COMPLETED since — the 2026-07-28 outage", () => {
    // A dead extractor stops writing episode nodes too, so the outage stays loud. (It used to be the
    // stale FACT that accused; that is now insufficient on its own — see the next test.)
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(0.2),
        newestFactAtMs: at(30),
        newestEpisodicAtMs: at(30),
      })
    ).toBe(true);
  });

  it("NOT stalled on stale facts alone when jobs are completing — the false positive, removed", () => {
    // Same fixture as above except a job finished moments ago. Under the old predicate this was a
    // stall; it is the exact prod state that produced "accepting episodes but extracting 0 facts".
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(0.2),
        newestFactAtMs: at(30),
        newestEpisodicAtMs: at(0.1),
      })
    ).toBe(false);
  });

  it("healthy: jobs completing just behind the episodes", () => {
    // Extraction is serial and ~10-20s per episode, so completion ALWAYS trails. A small gap is
    // normal and must not page anyone.
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(0),
        newestFactAtMs: at(1),
        newestEpisodicAtMs: at(1),
      })
    ).toBe(false);
  });

  it("healthy: a QUIET period — both are old together", () => {
    // Nothing was projected for a week, so of course no facts appeared. Measuring fact age against
    // `now` instead of against the newest EPISODE would cry stall on every quiet team.
    expect(
      deriveGraphExtractionStalled({
        episodes: 1243,
        facts: 400,
        newestEpisodeAtMs: at(200),
        newestFactAtMs: at(201),
      })
    ).toBe(false);
  });

  it("still catches the ORIGINAL failure — zero facts, whatever the timestamps say", () => {
    expect(
      deriveGraphExtractionStalled({ episodes: 1243, facts: 0, newestEpisodeAtMs: at(0), newestFactAtMs: null })
    ).toBe(true);
    expect(deriveGraphExtractionStalled({ episodes: N, facts: 0 })).toBe(true);
  });

  it("cannot tell: a missing timestamp is never evidence of a stall", () => {
    // Neo4j unreadable, or an older Graphiti that didn't stamp created_at. "Don't know" is not "broken".
    expect(
      deriveGraphExtractionStalled({ episodes: 1243, facts: 400, newestEpisodeAtMs: at(0), newestFactAtMs: null })
    ).toBe(false);
    expect(
      deriveGraphExtractionStalled({ episodes: 1243, facts: 400, newestEpisodeAtMs: null, newestFactAtMs: at(30) })
    ).toBe(false);
  });

  it("respects the episode threshold for the recency check too", () => {
    // A handful of episodes on a fresh install can legitimately lag; don't flag what we can't judge.
    expect(
      deriveGraphExtractionStalled({ episodes: 3, facts: 1, newestEpisodeAtMs: at(0), newestFactAtMs: at(50) })
    ).toBe(false);
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

describe("the lag budget boundary", () => {
  // Measured on the EPISODIC clock since STALLPROBE-1 — fact age no longer accuses.
  const base = {
    episodes: 1243,
    facts: 400,
    newestEpisodeAtMs: 1_000_000_000_000,
    newestFactAtMs: 1_000_000_000_000 - 30 * 3_600_000, // deliberately stale: must not matter
  };
  it("is exclusive: exactly at budget is healthy, one ms past is stalled", () => {
    expect(
      deriveGraphExtractionStalled({ ...base, newestEpisodicAtMs: base.newestEpisodeAtMs - EXTRACTION_LAG_BUDGET_MS })
    ).toBe(false);
    expect(
      deriveGraphExtractionStalled({
        ...base,
        newestEpisodicAtMs: base.newestEpisodeAtMs - EXTRACTION_LAG_BUDGET_MS - 1,
      })
    ).toBe(true);
  });

  it("a completion NEWER than the newest episode is healthy, not negative-lag nonsense", () => {
    expect(deriveGraphExtractionStalled({ ...base, newestEpisodicAtMs: base.newestEpisodeAtMs + 60_000 })).toBe(false);
  });

  it("an OMITTED field (tests aren't typechecked) reads as unknown, never as healthy-by-accident", () => {
    // Pins the desired OUTCOME for an omitted field: unknown must never accuse. Stated honestly: this
    // does NOT pin the `?? null` itself — removing that normalisation leaves this green, because
    // `NaN > budget` is already false. The normalisation is defensive, not behavioural (see the comment
    // at the call site), and mutation-testing it is how that was established rather than assumed.
    const omitted = { ...base } as Parameters<typeof deriveGraphExtractionStalled>[0];
    expect(deriveGraphExtractionStalled(omitted)).toBe(false);
    // …and it must not suppress the zero-facts stall either.
    expect(deriveGraphExtractionStalled({ ...omitted, facts: 0 })).toBe(true);
  });
});

/**
 * LIVENESS IS THE EPISODE NODE (STALLPROBE-1 / AIO-876).
 *
 * The lag half used to compare the newest episode against the newest FACT, which asks "when did the
 * graph last learn something NEW?" and was read as "when did a job last FINISH?". On a mature graph
 * those diverge — prod runs 6.6 `dedupe_edges` per `extract_edges` (measured 2026-08-12), so most extracted edges resolve
 * onto an existing edge and create no `RELATES_TO` — so the clock freezes while extraction works. That
 * produced "accepting episodes but extracting 0 facts" one minute after a clean pipeline run.
 *
 * `Episodic.created_at` is the honest signal: written by `add_nodes_and_edges_bulk` (the single Neo4j
 * write, last thing a job does), it can never deduplicate, and it is wall-clock rather than backdated.
 * Two earlier designs based on the LLM spend ledger were killed in review — see the spec — so these
 * pin BOTH directions: the false positive must go, and a real outage must stay loud.
 */
describe("deriveGraphExtractionStalled — episode-node liveness", () => {
  const EPISODE_AT = Date.parse("2026-08-12T00:15:02Z");
  // A LITERAL, deliberately not `MIN_EPISODES_FOR_EXTRACTION_SIGNAL * 10`. Seeding a fixture from the
  // constant under test makes it scale with a mutation of that constant, so raising the floor would
  // leave this whole block green — the repo's own mutation-fixture-sizing rule, caught here by review.
  // 2347 is the real prod episode count from the 2026-08-12 incident this block reproduces.
  const DEDUP_FROZEN = {
    episodes: 2347,
    facts: 113_352,
    newestEpisodeAtMs: EPISODE_AT,
    newestFactAtMs: EPISODE_AT - (EXTRACTION_LAG_BUDGET_MS + 3_600_000),
  };

  it("is NOT stalled when a job FINISHED recently, however old the newest fact is", () => {
    // The reported false positive, in the shape it occurred: extraction completed 60s after the
    // episode was projected and every new edge deduplicated.
    expect(
      deriveGraphExtractionStalled({ ...DEDUP_FROZEN, newestEpisodicAtMs: EPISODE_AT + 60_000 })
    ).toBe(false);
  });

  it("IS stalled when episodes are pushed and NO job completes — the real outage", () => {
    // The direction that must not be weakened. This now covers the whole pipeline including the Neo4j
    // write, which both rejected ledger designs left uncovered.
    expect(
      deriveGraphExtractionStalled({
        ...DEDUP_FROZEN,
        newestEpisodicAtMs: EPISODE_AT - (EXTRACTION_LAG_BUDGET_MS + 1),
      })
    ).toBe(true);
  });

  it("is exclusive at the budget: exactly at it is healthy, one ms past is stalled", () => {
    const at = (d: number) => deriveGraphExtractionStalled({ ...DEDUP_FROZEN, newestEpisodicAtMs: EPISODE_AT - d });
    expect(at(EXTRACTION_LAG_BUDGET_MS)).toBe(false);
    expect(at(EXTRACTION_LAG_BUDGET_MS + 1)).toBe(true);
  });

  it("zero facts outranks liveness — a completing extractor producing nothing is still broken", () => {
    expect(
      deriveGraphExtractionStalled({
        episodes: 2347,
        facts: 0,
        newestEpisodeAtMs: EPISODE_AT,
        newestFactAtMs: null,
        newestEpisodicAtMs: EPISODE_AT + 60_000,
      })
    ).toBe(true);
  });

  it("an unknown episodic timestamp never manufactures a stall", () => {
    // Neo4j unreadable/unconfigured. A different leg owns reachability; "don't know" must not accuse.
    expect(deriveGraphExtractionStalled({ ...DEDUP_FROZEN, newestEpisodicAtMs: null })).toBe(false);
  });

  it("…but an unknown episodic timestamp does NOT suppress the zero-facts stall", () => {
    expect(
      deriveGraphExtractionStalled({
        episodes: 2347,
        facts: 0,
        newestEpisodeAtMs: EPISODE_AT,
        newestFactAtMs: null,
        newestEpisodicAtMs: null,
      })
    ).toBe(true);
  });

  it("FACT AGE ALONE CAN NO LONGER ACCUSE — the whole point of the change", () => {
    // The control that would have caught the original bug. Facts arbitrarily stale, jobs completing.
    expect(
      deriveGraphExtractionStalled({
        ...DEDUP_FROZEN,
        newestFactAtMs: EPISODE_AT - 30 * 86_400_000,
        newestEpisodicAtMs: EPISODE_AT,
      })
    ).toBe(false);
  });
});

/**
 * WHICH stall, and what its sentence may claim (STALLPROBE-1, found by review).
 *
 * Before this slice both causes were one hard-coded sentence — "accepting episodes but extracting 0
 * facts" — because a stall only ever meant `facts === 0`. Liveness stalls fire with facts ≫ 0 (prod
 * holds 113,352), so that sentence became a claim contradicted by the very card printing it, ON THE
 * TRUE-POSITIVE PATH: the one an operator has to believe. These pin the split so no surface can
 * regress to composing its own copy.
 */
describe("extractionStallCause / extractionStallReason", () => {
  it("is null when nothing is stalled — no cause, no sentence", () => {
    expect(extractionStallCause(false, 0)).toBeNull();
    expect(extractionStallCause(false, 113_352)).toBeNull();
  });

  it("says never-extracted ONLY for zero facts, and stopped for every other count", () => {
    expect(extractionStallCause(true, 0)).toBe("never-extracted");
    expect(extractionStallCause(true, 1)).toBe("stopped");
    expect(extractionStallCause(true, 113_352)).toBe("stopped");
    // Unknown fact count is NOT zero facts. `facts === null` means Neo4j was unreadable, and
    // "don't know" must never be upgraded into the stronger of the two accusations.
    expect(extractionStallCause(true, null)).toBe("stopped");
  });

  it("the STOPPED sentence never claims zero facts, and names the real count", () => {
    const reason = extractionStallReason("stopped", {
      episodes: 2347,
      facts: 113_352,
      lagHours: 9,
    });
    expect(reason).toContain("113352");
    expect(reason).toContain("about 9h");
    // The regression this test exists for: the never-extracted copy leaking onto the liveness path.
    expect(reason).not.toContain("0 extracted facts");
    expect(reason).not.toMatch(/failing on every job/);
  });

  it("the NEVER-EXTRACTED sentence is the one allowed to say zero facts", () => {
    const reason = extractionStallReason("never-extracted", {
      episodes: 2347,
      facts: 0,
      lagHours: null,
    });
    expect(reason).toContain("0 extracted facts");
    expect(reason).toContain("2347 episodes");
  });

  it("degrades an UNKNOWN fact count to prose, not to a measured-looking zero", () => {
    // `facts === null` is "Neo4j unreadable", not "zero facts". Printing "holds 0 facts from before"
    // in the one sentence an operator acts on is this file's own banned pattern. Unreachable from
    // production today (the predicate returns false on null facts) — pinned because the function is
    // exported and the next caller is free to reach it.
    const reason = extractionStallReason("stopped", { episodes: 30, facts: null, lagHours: 7 });
    expect(reason).not.toMatch(/holds 0 facts/);
    expect(reason).toContain("currently unreadable");
  });

  it("degrades a null lag to prose instead of printing 'nullh'", () => {
    // A rendered `null` is the class of defect this file's own header calls out: a number on a card
    // with no way to tell it apart from a measurement.
    const reason = extractionStallReason("stopped", { episodes: 10, facts: 5, lagHours: null });
    expect(reason).toContain("for some time");
    expect(reason).not.toContain("null");
  });
});

describe("extractionLagHours", () => {
  it("is null when either end is unknown — never a 0 that reads as 'no lag'", () => {
    expect(extractionLagHours(null, 1_000)).toBeNull();
    expect(extractionLagHours(1_000, null)).toBeNull();
    expect(extractionLagHours(null, null)).toBeNull();
  });

  it("rounds the episode-to-completion gap to hours", () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    expect(extractionLagHours(now, now - 9 * 3_600_000)).toBe(9);
    // A completion NEWER than the newest episode is negative, not clamped — the predicate already
    // treats it as healthy, and clamping here would hide a clock-skew problem rather than show it.
    expect(extractionLagHours(now, now + 3_600_000)).toBe(-1);
  });
});

/**
 * THE LIVENESS READ'S POPULATION (STALLPROBE-1, round-4 review).
 *
 * `newestEpisodicAtMs` is SUBTRACTED FROM `newestEpisodeAtMs`, so the two must count the same
 * episodes. Two review rounds found two ways they did not:
 *   • by GROUP — a global read let another team's completed job refresh this team's clock;
 *   • by KIND — a group-scoped read still counted `correction:<arc_id>` episodes, which
 *     `lib/graph/arcs.ts` POSTs into the same team group with NO `graph_episodes` row. An admin
 *     recomputing an arc mid-outage would have refreshed the clock and silenced the alarm for the
 *     whole 6h budget while every item episode was failing.
 *
 * The Cypher is IO, so what is pinned here is the contract the query has to honour: the prefix
 * constant is shared with the projector's own naming, and it is a POSITIVE match (only `items:`
 * counts) rather than a `correction:` denylist, so the next non-ledger episode kind is excluded by
 * default instead of needing someone to remember a new rule.
 */
describe("the liveness read counts ledger-backed item episodes only", () => {
  it("shares its prefix with the projector's episode names — one constant, not two literals", () => {
    expect(episodeName("abc", 0, 1)).toBe(`${ITEM_EPISODE_PREFIX}abc`);
    expect(episodeName("abc", 2, 5)).toBe(`${ITEM_EPISODE_PREFIX}abc#2`);
  });

  it("excludes the arc-correction writeback, which has no ledger row behind it", () => {
    // The exact name `lib/graph/arcs.ts` POSTs. It must NOT match the liveness prefix.
    expect(`correction:${"arc-8144f88eb1"}`.startsWith(ITEM_EPISODE_PREFIX)).toBe(false);
    // …and the projector's names must, or the probe would go permanently silent instead.
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
});
