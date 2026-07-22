import { afterAll, beforeAll, describe, expect, it } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { recentFacts, recentEvents } from "@/lib/graph/learning";
import { closeNeo4j } from "@/lib/graph/neo4j";

/**
 * Tier-isolation proof for the direct Neo4j reads behind the Brain-Learning panel. Graphiti has no
 * tier awareness — tier is encoded in `group_id`, and `WHERE group_id IN $groups` is the SOLE thing
 * stopping an `external` viewer from reading team facts (no RLS backstop, CLAUDE.md §5). Self-skips
 * unless NEO4J_TEST is set (needs a real Neo4j): `npm run db:test:neo4j:up && npm run test:neo4j`.
 */

const live = process.env.NEO4J_TEST ? describe : describe.skip;

live("Graphiti Neo4j tier isolation (real Neo4j)", () => {
  const TEAM = "acme_team";
  const EXT = "acme_external";
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let driver: Driver;

  beforeAll(async () => {
    driver = neo4j.driver(
      process.env.NEO4J_URL as string,
      neo4j.auth.basic(process.env.NEO4J_USER as string, process.env.NEO4J_PASSWORD as string)
    );
    const s = driver.session();
    try {
      await s.run("MATCH (n) DETACH DELETE n"); // clean slate
      // A team fact and an external fact — same shape Graphiti writes (Entity-RELATES_TO->Entity).
      await s.run(
        `CREATE (a1:Entity:Person {name:'Alice', group_id:$team})
         CREATE (b1:Entity {name:'Payments', group_id:$team})
         CREATE (a1)-[:RELATES_TO {uuid:'f-team', fact:'Alice owns Payments', created_at:datetime(), group_id:$team, episodes:['ep1']}]->(b1)
         CREATE (e1:Episodic {uuid:'ep1', name:'items:item-team', source:'slack', source_description:'Slack — standup', created_at:datetime(), group_id:$team})
         CREATE (e1)-[:MENTIONS]->(a1)
         CREATE (a2:Entity:Person {name:'Bob', group_id:$ext})
         CREATE (b2:Entity {name:'PublicSite', group_id:$ext})
         CREATE (a2)-[:RELATES_TO {uuid:'f-ext', fact:'Bob owns PublicSite', created_at:datetime(), group_id:$ext, episodes:['ep2']}]->(b2)
         CREATE (e2:Episodic {uuid:'ep2', name:'items:item-ext', source:'notion', source_description:'Notion — public doc', created_at:datetime(), group_id:$ext})
         CREATE (e2)-[:MENTIONS]->(a2)`,
        { team: TEAM, ext: EXT }
      );
    } finally {
      await s.close();
    }
  });

  afterAll(async () => {
    await driver?.close();
    await closeNeo4j();
  });

  it("returns facts for a tier's visible group, and carries the type + episodes", async () => {
    const facts = await recentFacts([TEAM], since);
    expect(facts.map((f) => f.fact)).toContain("Alice owns Payments");
    const team = facts.find((f) => f.id === "f-team")!;
    expect(team.subjectType).toBe("person"); // subject entity label → badge
    expect(team.episodeUuids).toEqual(["ep1"]); // event linkage for Layer 2
    expect(facts.map((f) => f.fact)).not.toContain("Bob owns PublicSite");
  });

  it("an external viewer NEVER sees team facts (sole tier enforcement)", async () => {
    const facts = await recentFacts([EXT], since);
    expect(facts.map((f) => f.fact)).toEqual(["Bob owns PublicSite"]);
  });

  it("empty visible-groups returns nothing (fail closed)", async () => {
    expect(await recentFacts([], since)).toEqual([]);
  });

  // Noise filter (measured ~1/3 of a real team's edges): Graphiti records entity-dedup as a
  // RELATES_TO edge named IS_DUPLICATE_OF with fact text "<x> is a duplicate of <x>", and stamps
  // superseded edges with expired_at but leaves them in the graph. Both carry fresh created_at and were
  // flooding the recency pool → recentFacts must drop both while keeping real facts. Red before A1.
  it("drops IS_DUPLICATE_OF bookkeeping + expired edges, keeps real facts", async () => {
    const s = driver.session();
    try {
      await s.run(
        `MATCH (a1:Entity {name:'Alice'}), (b1:Entity {name:'Payments'})
         CREATE (a1)-[:RELATES_TO {uuid:'f-dup', name:'IS_DUPLICATE_OF', fact:'user is a duplicate of user', created_at:datetime(), group_id:$team, episodes:['ep1']}]->(b1)
         CREATE (a1)-[:RELATES_TO {uuid:'f-exp', name:'OWNS', fact:'Alice used to own Billing', created_at:datetime(), expired_at:datetime(), group_id:$team, episodes:['ep1']}]->(b1)
         CREATE (a1)-[:RELATES_TO {uuid:'f-named', name:'MENTORS', fact:'Alice mentors Bob', created_at:datetime(), group_id:$team, episodes:['ep1']}]->(b1)`,
        { team: TEAM }
      );
      const facts = await recentFacts([TEAM], since);
      const texts = facts.map((f) => f.fact);
      expect(texts).toContain("Alice owns Payments"); // real fact survives (no name property)
      // A named, non-expired edge MUST survive — guards against an over-broad filter (e.g. dropping
      // every named edge, which would blank a prod graph where every real edge carries a name).
      expect(texts).toContain("Alice mentors Bob");
      expect(texts).not.toContain("user is a duplicate of user"); // IS_DUPLICATE_OF dropped
      expect(texts).not.toContain("Alice used to own Billing"); // expired dropped
      expect(facts.map((f) => f.id)).not.toContain("f-dup");
      expect(facts.map((f) => f.id)).not.toContain("f-exp");
    } finally {
      await s.run("MATCH ()-[r:RELATES_TO]->() WHERE r.uuid IN ['f-dup','f-exp','f-named'] DELETE r");
      await s.close();
    }
  });

  it("events: returns the team's events with participants + grouped facts, item link", async () => {
    const events = await recentEvents([TEAM], since);
    const ev = events.find((e) => e.id === "ep1")!;
    expect(ev.itemId).toBe("item-team");
    expect(ev.source).toBe("slack");
    expect(ev.participants).toContain("Alice");
    expect(ev.facts).toContain("Alice owns Payments");
    expect(events.map((e) => e.id)).not.toContain("ep2");
  });

  it("events: an external viewer NEVER sees team events", async () => {
    const events = await recentEvents([EXT], since);
    expect(events.map((e) => e.id)).toEqual(["ep2"]);
  });

  // Sparse-data fallback (a stale graph must not render blank). A `since` in the FUTURE makes the
  // windowed query return nothing — the same shape as a graph whose newest fact is weeks old. The
  // fallback must then surface the most-recent-N regardless of age, WITHOUT dropping tier scoping.
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  it("facts: falls back to most-recent-N when the window is empty (still tier-scoped)", async () => {
    const facts = await recentFacts([TEAM], future);
    expect(facts.map((f) => f.fact)).toContain("Alice owns Payments"); // stale fact surfaces
    const ext = await recentFacts([EXT], future);
    expect(ext.map((f) => f.fact)).toEqual(["Bob owns PublicSite"]); // external still scoped
    expect(ext.map((f) => f.fact)).not.toContain("Alice owns Payments");
  });

  it("events: falls back to most-recent-N when the window is empty (still tier-scoped)", async () => {
    const events = await recentEvents([TEAM], future);
    expect(events.map((e) => e.id)).toContain("ep1"); // stale event surfaces
    expect(events.map((e) => e.id)).not.toContain("ep2"); // external event never leaks
  });
});

/**
 * Work-time ordering (docs/design/arcs-work-time-chronology.md): facts/events order + timestamp by
 * WORK time (`valid_at` clamped to `created_at`), not extraction time — so "recent" means recent work
 * and a re-projected old doc stops looking new. Self-skips unless NEO4J_TEST is set (local-only tier).
 */
live("Brain-Learning work-time ordering (real Neo4j)", () => {
  const WT = "wt_order";
  let driver: Driver;

  beforeAll(async () => {
    driver = neo4j.driver(
      process.env.NEO4J_URL as string,
      neo4j.auth.basic(process.env.NEO4J_USER as string, process.env.NEO4J_PASSWORD as string)
    );
    const s = driver.session();
    try {
      await s.run("MATCH (n) WHERE n.group_id = $wt DETACH DELETE n", { wt: WT });
      // Realistic: work (valid_at) precedes extraction (created_at). created-order (desc): A,B,D,C —
      // but WORK-order (desc, by valid_at; D's future date clamped to its created_at; C has no valid_at
      // → created_at): D(Jun8), A(Jun4), B(Jun3), C(Jun2). The two orders differ → proves work-time sort.
      await s.run(
        `CREATE (:Entity {name:'sA',group_id:$wt})-[:RELATES_TO {uuid:'wA',fact:'fact A',group_id:$wt,episodes:[],created_at:datetime('2026-06-10T00:00:00Z'),valid_at:datetime('2026-06-04T00:00:00Z')}]->(:Entity {name:'oA',group_id:$wt})
         CREATE (:Entity {name:'sB',group_id:$wt})-[:RELATES_TO {uuid:'wB',fact:'fact B',group_id:$wt,episodes:[],created_at:datetime('2026-06-09T00:00:00Z'),valid_at:datetime('2026-06-03T00:00:00Z')}]->(:Entity {name:'oB',group_id:$wt})
         CREATE (:Entity {name:'sC',group_id:$wt})-[:RELATES_TO {uuid:'wC',fact:'fact C',group_id:$wt,episodes:[],created_at:datetime('2026-06-02T00:00:00Z')}]->(:Entity {name:'oC',group_id:$wt})
         CREATE (:Entity {name:'sD',group_id:$wt})-[:RELATES_TO {uuid:'wD',fact:'fact D',group_id:$wt,episodes:[],created_at:datetime('2026-06-08T00:00:00Z'),valid_at:datetime('2030-01-01T00:00:00Z')}]->(:Entity {name:'oD',group_id:$wt})`,
        { wt: WT }
      );
    } finally {
      await s.close();
    }
  });

  afterAll(async () => {
    await driver?.close();
    await closeNeo4j();
  });

  it("orders by WORK time (valid_at), returns it as `at`, falls back to created_at, clamps a future valid_at", async () => {
    const facts = await recentFacts([WT], null);
    expect(facts.map((f) => f.fact)).toEqual(["fact D", "fact A", "fact B", "fact C"]); // work-order, not created-order (A,B,D,C)
    expect(facts.find((f) => f.fact === "fact A")!.at).toMatch(/^2026-06-04/); // valid_at (not created 2026-06-10)
    expect(facts.find((f) => f.fact === "fact C")!.at).toMatch(/^2026-06-02/); // no valid_at → created_at fallback
    expect(facts.find((f) => f.fact === "fact D")!.at).toMatch(/^2026-06-08/); // future valid_at (2030) clamped to created_at
  });

  it("a WORK-time window excludes a re-projected old fact (extracted now, worked 8d ago)", async () => {
    const WW = "wt_window";
    const now = new Date().toISOString();
    const d8 = new Date(Date.now() - 8 * 86400_000).toISOString();
    const d1h = new Date(Date.now() - 3600_000).toISOString();
    const s = driver.session();
    try {
      await s.run("MATCH (n) WHERE n.group_id=$wt DETACH DELETE n", { wt: WW });
      await s.run(
        `CREATE (:Entity {name:'se',group_id:$wt})-[:RELATES_TO {uuid:'wE',fact:'reprojected old',group_id:$wt,episodes:[],created_at:datetime($now),valid_at:datetime($d8)}]->(:Entity {name:'oe',group_id:$wt})
         CREATE (:Entity {name:'sf',group_id:$wt})-[:RELATES_TO {uuid:'wF',fact:'fresh work',group_id:$wt,episodes:[],created_at:datetime($now),valid_at:datetime($d1h)}]->(:Entity {name:'of',group_id:$wt})`,
        { wt: WW, now, d8, d1h }
      );
    } finally {
      await s.close();
    }
    const facts = await recentFacts([WW], new Date(Date.now() - 86400_000).toISOString());
    expect(facts.map((f) => f.fact)).toContain("fresh work");
    expect(facts.map((f) => f.fact)).not.toContain("reprojected old"); // worked 8d ago → outside the 24h WORK window
  });

  it("recentEvents orders by the work-time INSTANT, not the raw offset string", async () => {
    const WE = "wt_events";
    const now = new Date().toISOString();
    const s = driver.session();
    try {
      // epX valid = 10:00+02:00 = 08:00Z; epY valid = 09:00Z → epY is the later INSTANT. A raw-string
      // sort ("10:00+02:00" > "09:00Z") would wrongly put epX first; the datetime sort key must not.
      await s.run("MATCH (n) WHERE n.group_id=$wt DETACH DELETE n", { wt: WE });
      await s.run(
        `CREATE (:Episodic {uuid:'epX',name:'items:x',source:'notion',source_description:'X',group_id:$wt,created_at:datetime($now),valid_at:datetime('2026-06-01T10:00:00+02:00')})
         CREATE (:Episodic {uuid:'epY',name:'items:y',source:'notion',source_description:'Y',group_id:$wt,created_at:datetime($now),valid_at:datetime('2026-06-01T09:00:00Z')})`,
        { wt: WE, now }
      );
    } finally {
      await s.close();
    }
    const events = await recentEvents([WE], "2026-01-01T00:00:00Z");
    expect(events.map((e) => e.id)).toEqual(["epY", "epX"]); // later instant first, offset-safe
  });
});
