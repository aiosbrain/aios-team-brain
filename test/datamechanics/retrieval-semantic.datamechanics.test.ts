import { beforeEach, describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { projectItemsToGraph } from "@/lib/graph/project";
import { GraphitiClient } from "@/lib/graph/graphiti-client";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * LIVE eval for semantic retrieval (Organ 3). Proves that Graphiti-backed query expansion closes the
 * paraphrase gaps the keyword-FTS floor misses (the 3 gaps recorded in retrieval-eval). It needs a
 * running Graphiti stack + an LLM key for extraction, so it SELF-SKIPS unless GRAPHITI_URL is set —
 * CI (keyword-only) is unaffected; run it locally against `graphiti/docker-compose.yml`:
 *   GRAPHITI_URL=http://localhost:8000 npm run test:datamechanics:local -- retrieval-semantic
 */

const live = process.env.GRAPHITI_URL ? describe : describe.skip;

interface Doc { path: string; body: string; kind?: "deliverable" | "transcript" }

// The 3 keyword-floor gap targets — paraphrase questions with no surface-term overlap.
const TARGETS: Doc[] = [
  { path: "deliverables/auth-redesign.md", body: "Authentication redesign: we migrated to passwordless magic links and removed the legacy password flow entirely." },
  { path: "transcripts/customer-call.md", kind: "transcript", body: "Call with Acme Corp: they require single sign-on and audit logs before signing the enterprise contract." },
  { path: "deliverables/perf-notes.md", body: "The dashboard felt sluggish; we added database indexes and cut p95 latency from 1200ms to 180ms." },
];
// Fillers (ingested after) dominate the recency window so only search can surface the targets.
const FILLERS: Doc[] = [
  { path: "deliverables/lunch.md", body: "Team lunch moves to Thursdays; vegetarian options added to the catering order." },
  { path: "deliverables/wifi.md", body: "Office wifi password rotates monthly; grab it from the front desk." },
  { path: "deliverables/holiday.md", body: "Office closed the last week of December for the winter break." },
  { path: "deliverables/expenses.md", body: "Submit travel expense reports by the fifth of each month." },
  { path: "deliverables/parking.md", body: "Visitor parking is in lot C; register the plate at reception." },
  { path: "deliverables/allhands.md", body: "The monthly all-hands moves to the larger room downstairs." },
  { path: "deliverables/desk.md", body: "Hot desks are bookable a week ahead through the room calendar." },
  { path: "deliverables/printer.md", body: "The third-floor printer is back online; install the driver from the portal." },
];
const GAPS = [
  { q: "how do users sign in now?", target: "deliverables/auth-redesign.md" },
  { q: "what does the large prospect need before they commit?", target: "transcripts/customer-call.md" },
  { q: "what made the app faster?", target: "deliverables/perf-notes.md" },
];

let seed: Seed;

live("semantic retrieval via live Graphiti", () => {
  beforeEach(async () => {
    seed = await seedTeam();
    for (const d of [...TARGETS, ...FILLERS]) {
      await ingest(seed, { kind: d.kind ?? "deliverable", path: d.path, body: d.body, access: "team" });
    }
  });

  it("closes the keyword-floor paraphrase gaps once items are in the graph", async () => {
    // Project into Graphiti, then wait for async LLM extraction (serial; ~15s/episode).
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: new GraphitiClient() });
    await new Promise((r) => setTimeout(r, 180_000));

    const missed: string[] = [];
    for (const g of GAPS) {
      const ctx = await retrieve(db(), seed.teamId, "team", g.q);
      if (!ctx.sources.map((s) => s.path).includes(g.target)) missed.push(`${g.q} → ${g.target}`);
    }
    console.info(`[semantic-live] gaps closed: ${GAPS.length - missed.length}/${GAPS.length}` + (missed.length ? `; still missed: ${missed.join("; ")}` : ""));
    expect(missed, "semantic expansion should retrieve these paraphrase targets").toEqual([]);
  }, 300_000);
});
