import { afterEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { GraphProvenanceUnavailableError } from "@/lib/graph/provenance-read";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam, memberRetrieveEnforce } from "./helpers";

// The provenance-complete graph read, observed (never replaced unless a test asks): `onReject` signals the
// moment the REAL read refuses, and `certified` answers with one fact certified under the team's current
// epoch — the shape a working Neo4j read returns — to pin the success path through retrieve().
const graphRead = vi.hoisted(() => ({
  calls: 0,
  certified: false,
  onReject: null as null | ((error: unknown) => void),
}));
vi.mock("@/lib/graph/provenance-read", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/graph/provenance-read")>();
  return {
    ...real,
    readAuthorizedGraphFactsResult: async (...args: Parameters<typeof real.readAuthorizedGraphFactsResult>) => {
      graphRead.calls++;
      if (graphRead.certified) {
        const { revocationEpoch } = await import("@/lib/access/authorization-epoch");
        return {
          facts: [{ id: "f1", fact: "Alex owns payments", at: "2026-06-25T00:00:00Z", subjectType: "Person",
            subject: "Alex", object: "payments", episodeUuids: [] }],
          incomplete: false, nextOffset: null, checked: 1,
          epoch: await revocationEpoch(args[0], args[1].teamId), itemIds: [], itemsComplete: true,
        };
      }
      try {
        return await real.readAuthorizedGraphFactsResult(...args);
      } catch (error) {
        graphRead.onReject?.(error);
        throw error;
      }
    },
  };
});

const GRAPH_URL = "http://graphiti.test";

type GraphitiSearchBody = {
  query: string;
  group_ids: string[];
  max_facts: number;
};

function stubGraphiti(facts = [{ fact: "Alex owns payments", valid_at: "2026-06-25T00:00:00Z" }]) {
  const requests: GraphitiSearchBody[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${GRAPH_URL}/search`) {
      requests.push(JSON.parse(String(init?.body)) as GraphitiSearchBody);
      return new Response(JSON.stringify({ facts }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubEnv("GRAPHITI_URL", GRAPH_URL);
  return { requests, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  graphRead.calls = 0;
  graphRead.certified = false;
  graphRead.onReject = null;
});

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Graphiti tier scoping (real routes/retrieval, stubbed Graphiti)", () => {
  // Deleted WITH their subject (ENFB-1): the two route arms pinned the LEGACY tier-suffixed
  // partition scheme ("only external group_ids for an external key" / "both tier groups for a
  // team key") — the route now serves the ORACLE's stored-pointer partitions, and that behavior
  // incl. the external-member arm is pinned in test/datamechanics/enfb-graph-query-scope.

  it("retrieve() fails closed when provenance-complete graph reads are unavailable — no Graphiti search", async () => {
    const seed = await seedTeam();
    const enforce = await memberRetrieveEnforce(seed, "external");
    const { requests } = stubGraphiti();
    // The no-provenance condition is explicit, not inherited from whatever the runner's env holds: with
    // no Neo4j, a fact's source items cannot be proven, so the graph leg REFUSES (a typed, retryable
    // error) rather than answering from provenance-free Graphiti facts or pretending the graph is empty.
    vi.stubEnv("NEO4J_URL", "");

    await expect(retrieve(db(), seed.teamId, "external", "who owns payments?", null, enforce))
      .rejects.toBeInstanceOf(GraphProvenanceUnavailableError);
    expect(requests).toHaveLength(0);
  });

  it("a graph refusal that settles while another leg is still pending is owned — no unhandled rejection — and retrieve rejects with it", async () => {
    const seed = await seedTeam();
    const enforce = await memberRetrieveEnforce(seed, "external");
    stubGraphiti();
    vi.stubEnv("NEO4J_URL", "");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let refused!: (error: unknown) => void;
    const graphRefused = new Promise<unknown>((resolve) => { refused = resolve; });
    graphRead.onReject = (error) => refused(error);
    // Gate an unrelated leg: the decisions read queues behind an exclusive lock held on another
    // connection, so retrieval is parked before it reaches the graph leg's consumption point.
    const gate = await getPool().connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await gate.query("commit");
      gate.release();
    };
    try {
      await gate.query("begin");
      await gate.query("lock table decisions in access exclusive mode");
      const outcome = retrieve(db(), seed.teamId, "external", "who owns payments?", null, enforce)
        .then(() => null, (error: unknown) => error);

      const original = await graphRefused;
      expect(original).toBeInstanceOf(GraphProvenanceUnavailableError);
      // Proof the other leg is genuinely still pending: the decisions read waits on the gate's lock.
      const waiting = await getPool().query(
        "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%from decisions%'",
      );
      expect((waiting.rows[0] as { n: number }).n).toBeGreaterThan(0);
      // Event-loop turns with the rejection settled and unconsumed: Node reports an unowned one here.
      await turn();
      await turn();
      expect(unhandled).toEqual([]);

      await release();
      // The ORIGINAL typed error reaches the caller — not [], not a translation, not a retry.
      expect(await outcome).toBe(original);
      expect(unhandled).toEqual([]);
    } finally {
      await release();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a successful graph read is still consumed: its certified fact reaches the context", async () => {
    const seed = await seedTeam();
    const enforce = await memberRetrieveEnforce(seed, "external");
    const { requests } = stubGraphiti();
    graphRead.certified = true;

    const ctx = await retrieve(db(), seed.teamId, "external", "who owns payments?", null, enforce);

    expect(ctx.structured).toContain("## Graph memory");
    expect(ctx.structured).toContain("Alex owns payments");
    expect(graphRead.calls).toBe(1);
    expect(requests).toHaveLength(0); // the provenance-complete read, never Graphiti /search
  });

  it("graph-disabled retrieval (no GRAPHITI_URL) still succeeds without any graph read", async () => {
    const seed = await seedTeam();
    const enforce = await memberRetrieveEnforce(seed, "external");
    vi.stubEnv("GRAPHITI_URL", "");
    vi.stubEnv("NEO4J_URL", "");

    const ctx = await retrieve(db(), seed.teamId, "external", "who owns payments?", null, enforce);

    expect(ctx.structured).not.toContain("## Graph memory");
    expect(graphRead.calls).toBe(0);
  });
});
