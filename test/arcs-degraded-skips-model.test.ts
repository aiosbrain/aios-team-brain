import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * The one behaviour this PR claims that `test/arcs-commit.test.ts` cannot see: when the synthesis inputs
 * are DEGRADED, the model is never called.
 *
 * I had written that off as untestable — "the fact pool is empty without Graphiti, so synthesis returns
 * at its first guard". That was giving up early: the module boundary is a seam, and `vi.mock` is already
 * used across this tier. Mocking the graph legs lets a degraded synthesis actually be driven.
 *
 * Why it matters enough to test: `degraded` is set by the resolution legs but ACTED ON in `commitArcs`,
 * so it is entirely possible to wire it correctly and still pay for every refused synthesis — which is
 * what the first cut of this change did. With a persistent failure that is one reasoning-model call per
 * retry, forever, for output nothing will ever publish.
 */

const factsMock = vi.hoisted(() => ({
  recentFacts: vi.fn(),
  resolveEpisodeItems: vi.fn(),
}));
const llmMock = vi.hoisted(() => ({ completeTextOrNull: vi.fn() }));
// The other two legs synthesis depends on. Both hit a real DB, so without mocks they fail in a unit
// test and mark the run degraded — which would make the assertion below pass for the wrong reason.
// (The control case caught exactly that.)
const gateMock = vi.hoisted(() => ({ arcIneligibleItemIds: vi.fn() }));
const creditMock = vi.hoisted(() => ({ resolveItemCredit: vi.fn() }));
const correctionsMock = vi.hoisted(() => ({ listArcCorrections: vi.fn(), recordArcCorrections: vi.fn() }));

vi.mock("@/lib/graph/learning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/learning")>()),
  recentFacts: factsMock.recentFacts,
  resolveEpisodeItems: factsMock.resolveEpisodeItems,
}));
vi.mock("@/lib/graph/arc-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/arc-eligibility")>()),
  arcIneligibleItemIds: gateMock.arcIneligibleItemIds,
}));
vi.mock("@/lib/attribution/contributor-credit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/attribution/contributor-credit")>()),
  resolveItemCredit: creditMock.resolveItemCredit,
}));
vi.mock("@/lib/graph/arc-corrections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/arc-corrections")>()),
  listArcCorrections: correctionsMock.listArcCorrections,
  recordArcCorrections: correctionsMock.recordArcCorrections,
}));
vi.mock("@/lib/llm/complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/complete")>()),
  completeTextOrNull: llmMock.completeTextOrNull,
}));

/** Enough of a DbClient for the arc-cache read/write and the answering-key lookups to no-op. */
function fakeDb() {
  const upserts: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          maybeSingle: async () => ({ data: null }),
          order: () => ({ limit: async () => ({ data: [] }) }),
          limit: async () => ({ data: [] }),
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  } as unknown as DbClient;
  return { db, upserts };
}

/** Any non-empty key set — the LLM transport is mocked, so the values are never used. */
const KEYS = { anthropic: "test-key", openai: null, openrouter: null } as unknown as Parameters<
  typeof import("@/lib/graph/arcs").getArcs
>[5];

/** A unique-but-VALID tier group set. The randomness has to sit in the slug: group ids are
 *  `<slug>_<tier>` and `isExternalGroupId` keys on that suffix, so `acme_external_0.42` would read as a
 *  TEAM group and quietly defeat the tier assertion below. */
const slug = () => `acme${Math.floor(Math.random() * 1e9)}`;
const externalGroups = () => [`${slug()}_external`];
const teamGroups = () => {
  const t = slug();
  return [`${t}_team`, `${t}_external`];
};

/** A fakeDb whose arc_cache read returns an existing row (the SWR "stale prior" case). */
function fakeDbWithRow(row: Record<string, unknown>) {
  const upserts: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: row }) }),
          maybeSingle: async () => ({ data: null }),
          order: () => ({ limit: async () => ({ data: [] }) }),
          limit: async () => ({ data: [] }),
        }),
      }),
      upsert: async (r: Record<string, unknown>) => {
        upserts.push(r);
        return { error: null };
      },
    }),
  } as unknown as DbClient;
  return { db, upserts };
}

const FACT = {
  id: "f1",
  fact: "shipped the payments retry",
  at: "2026-07-20T00:00:00Z",
  subject: "alex",
  subjectType: "Person",
  object: "payments",
  objectType: "Service",
  episodeUuids: ["ep-1"],
};

describe("a degraded synthesis never reaches the model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
    gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
    creditMock.resolveItemCredit.mockResolvedValue(new Map());
    correctionsMock.listArcCorrections.mockResolvedValue({ corrections: [], ok: true });
    correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
  });

  it("skips the LLM entirely when the episode→item leg failed", async () => {
    // Facts exist, so this is NOT the quiet-window early return — synthesis genuinely has material and
    // would previously have run the model, produced an unattributed set, and had it refused downstream.
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({ items: new Map(), ok: false });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", externalGroups(), KEYS);

    expect(llmMock.completeTextOrNull).not.toHaveBeenCalled();
  });

  it("skips the LLM when the eligibility gate is unavailable", async () => {
    // The gate THROWS rather than guessing (#400). Synthesis must convert that to degraded and stop —
    // running the model over an unfiltered pool is how backlog noise reaches the arcs.
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });
    gateMock.arcIneligibleItemIds.mockRejectedValue(new Error("arc-eligibility lookup failed"));

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", externalGroups(), KEYS);

    expect(llmMock.completeTextOrNull).not.toHaveBeenCalled();
  });

  it("a FAILED fact read is not a quiet week: the row is short-lived, not fresh for 4h", async () => {
    // The leg that still conflated the two until this PR. `recentFacts` returning [] because Neo4j is
    // down looked byte-identical to a genuinely quiet window, so on a cold miss it wrote a blank panel
    // stamped fresh for the full TTL with no retry — H12's shape, on the last leg that had it.
    const { arcTtlMs } = await import("@/lib/graph/arc-cache");
    factsMock.recentFacts.mockResolvedValue({ facts: [], ok: false });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db, upserts } = fakeDb();
    const res = await getArcs(db, "team-1", "acme", "external", externalGroups(), KEYS);

    expect(llmMock.completeTextOrNull).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    // The requirement is unchanged — retried in minutes, not pinned for 4h — but it is now carried by the
    // `degraded` COLUMN plus the TTL derived from it, rather than by backdating `computed_at` (R2/M6).
    expect(upserts[0].degraded).toBe(true);
    const at = Date.parse(upserts[0].computed_at as string);
    expect(Date.now() - at).toBeLessThan(60_000); // the timestamp is honest now, not pushed into the past
    const remaining = arcTtlMs(true) - (Date.now() - at);
    expect(remaining).toBeGreaterThan(0); // not already stale — a persistent outage must not thrash
    expect(remaining).toBeLessThanOrEqual(10 * 60_000); // …retried in minutes, not hours
    // And the caller is TOLD, which the row alone never conveyed before this change.
    expect(res.freshness.degraded).toBe(true);
  });

  it("still reaches the model when the same legs are healthy", async () => {
    // The control. Without it, the assertion above would pass just as happily if arcs never called the
    // model at all under this harness — which is the way a mocked test quietly stops testing anything.
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", externalGroups(), KEYS);

    expect(llmMock.completeTextOrNull).toHaveBeenCalled();
  });
});


describe("H13: a stored correction reaches synthesis even with the graph wiped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
    gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
    creditMock.resolveItemCredit.mockResolvedValue(new Map());
    correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
  });

  it("puts the correction in the prompt on an ORDINARY synthesis, not just the recompute that made it", async () => {
    // The rebuild test the review report asked for. A correction used to influence later synthesis only
    // by having become a Graphiti fact, so resetting the graph didn't just lose the record — it lost the
    // influence, and arcs quietly reverted to the version a human had already rejected. Reading the
    // corrections from Postgres on every synthesis is what makes a rebuilt graph still produce corrected
    // arcs. Nothing here goes near Graphiti: the facts leg is mocked and GRAPHITI_URL is unset.
    correctionsMock.listArcCorrections.mockResolvedValue({
      corrections: [
        { arc_id: "a1", arc_title: "Payments", corrected_text: "Dana led this, not Alex.", created_by: null, updated_at: "" },
      ],
      ok: true,
    });
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "team", teamGroups(), KEYS);

    expect(llmMock.completeTextOrNull).toHaveBeenCalled();
    const prompt = JSON.stringify(llmMock.completeTextOrNull.mock.calls[0]);
    expect(prompt).toContain("Dana led this, not Alex.");
    // …and read for THIS team. The mock answers any argument, so without this a wrong teamId would pass.
    expect(correctionsMock.listArcCorrections).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      // PCCC6B-1: the ordinary tier synthesis asks for its own scope (legacy rows admitted).
      expect.objectContaining({ includeLegacy: true })
    );
  });
});

describe("H13 tier: corrections are team-authored and must not reach an EXTERNAL synthesis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[]}');
    gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
    creditMock.resolveItemCredit.mockResolvedValue(new Map());
    correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });
    correctionsMock.listArcCorrections.mockResolvedValue({
      corrections: [
        {
          arc_id: "a1",
          arc_title: "Payments",
          corrected_text: "INTERNAL: Dana is leaving, reassign this before the client hears.",
          created_by: null,
          updated_at: "",
        },
      ],
      ok: true,
    });
  });

  it("keeps correction text out of an external viewer's prompt", async () => {
    // The leak this fix could have introduced. `synthesizeArcs` serves BOTH tiers, so reading a
    // team-wide corrections table unconditionally would put internal editorial prose into the prompt
    // that writes the EXTERNAL arc row — the model paraphrases it into client-visible text and
    // `commitArcs` persists it under the external group_key. No RLS backstop (CLAUDE.md §5).
    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "external", externalGroups(), KEYS);

    expect(llmMock.completeTextOrNull).toHaveBeenCalled();
    expect(JSON.stringify(llmMock.completeTextOrNull.mock.calls[0])).not.toContain("INTERNAL:");
  });

  it("…while a team viewer still gets them", async () => {
    // The control: without it, the assertion above would pass just as happily if corrections never
    // reached any prompt at all.
    const { getArcs } = await import("@/lib/graph/arcs");
    const { db } = fakeDb();
    await getArcs(db, "team-1", "acme", "team", teamGroups(), KEYS);

    expect(JSON.stringify(llmMock.completeTextOrNull.mock.calls[0])).toContain("INTERNAL:");
  });
});

describe("a STORED correction must not disable the stability skip", () => {
  it("reuses the prior on a background refresh when only stored corrections exist", async () => {
    // The cost regression this nearly shipped with. `canReuseArcs`'s third argument means "a human just
    // edited this, re-synthesize regardless". Passing the merged set (request + stored) made it true
    // forever for any team that had EVER corrected an arc — permanently disabling the fact-hash skip and
    // re-running a reasoning model on every background refresh, for every viewer, indefinitely.
    //
    // Stored corrections don't need that flag: they're in `userPrompt`, so changing one changes
    // `factsHash` and the guard refuses reuse on its own. This pins the wiring, not just the predicate.
    vi.clearAllMocks();
    llmMock.completeTextOrNull.mockResolvedValue('{"arcs":[{"id":"a","title":"t","summary":"s","confidence":"low","participants":[],"supporting_sources":[],"evidence":[]}]}');
    gateMock.arcIneligibleItemIds.mockResolvedValue(new Set());
    creditMock.resolveItemCredit.mockResolvedValue(new Map());
    correctionsMock.recordArcCorrections.mockResolvedValue(undefined);
    correctionsMock.listArcCorrections.mockResolvedValue({
      corrections: [{ arc_id: "a1", arc_title: "P", corrected_text: "Dana led this.", created_by: null, updated_at: "" }],
      ok: true,
    });
    factsMock.recentFacts.mockResolvedValue({ facts: [FACT], ok: true });
    factsMock.resolveEpisodeItems.mockResolvedValue({
      items: new Map([["ep-1", { itemId: "11111111-1111-4111-8111-111111111111", source: "github" }]]),
      ok: true,
    });

    const { getArcs } = await import("@/lib/graph/arcs");
    const { ARC_CACHE_TTL_MS } = await import("@/lib/graph/arc-cache");
    // DIFFERENT group sets for the two passes, deliberately: the in-memory cache is keyed on the group
    // set and pass 1 leaves a FRESH entry there, so reusing the same key would make pass 2 a mem hit that
    // never reaches the refresh path — the test would pass without exercising anything. `factsHash` is
    // derived from the prompt, not the key, so it still matches across the two.
    const groupsA = teamGroups();
    const groupsB = teamGroups();

    // Pass 1 — cold miss. Synthesizes once and tells us the hash of these exact inputs.
    const first = fakeDb();
    await getArcs(first.db, "team-1", "acme", "team", groupsA, KEYS);
    expect(llmMock.completeTextOrNull).toHaveBeenCalledTimes(1);
    const factsHash = first.upserts[0].facts_hash as string;
    expect(factsHash).toBeTruthy();

    // Pass 2 — a STALE row whose inputs are unchanged. The background refresh should recognise the
    // matching hash and skip the model, exactly as it would for a team with no corrections at all.
    const stale = new Date(Date.now() - (ARC_CACHE_TTL_MS + 60_000)).toISOString();
    const second = fakeDbWithRow({
      arcs: [{ id: "a", title: "t", summary: "s", confidence: "low", participants: [], supporting_sources: [], evidence: [] }],
      computed_at: stale,
      facts_hash: factsHash,
    });
    await getArcs(second.db, "team-1", "acme", "team", groupsB, KEYS);
    await new Promise((r) => setTimeout(r, 50)); // the refresh is fire-and-forget

    expect(llmMock.completeTextOrNull).toHaveBeenCalledTimes(1); // still 1 — the model was NOT re-run
  });
});
