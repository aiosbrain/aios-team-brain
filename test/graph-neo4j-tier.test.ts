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
});
