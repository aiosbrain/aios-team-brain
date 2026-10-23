import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { createConversation } from "@/lib/chat/store";
import { episodeName } from "@/lib/graph/episode-name";
import { projectGroupId } from "@/lib/graph/group";
import { convergeIdentityAttribution, ingest } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam, db, keyHeaders, seedTeam, type Seed } from "./http-helpers";
import { FAKE_ANSWER, FAKE_MODEL, type GraphCaptured, type LlmCaptured } from "./fake-providers";

/**
 * TIERRET-1 AC-03 / AC-05 / AC-11 — the REAL `/api/v1/query` route over a real socket (`next start` +
 * the shared test Postgres), drained through `done`. OPT-IN: runs only under
 * `vitest.tierret1-query.config.ts`, whose global setup pins the server's LLM_BASE_URL to a test-only
 * loopback fake OpenAI-compatible endpoint, GRAPHITI_URL (the graph leg's switch) to a loopback stub,
 * and NEO4J_* to the isolated loopback TEST Neo4j, with every cloud credential blanked and
 * ANTHROPIC_BASE_URL pointed at a recorded trap. No paid or external call.
 *
 * LOCAL PREREQUISITE: `npm run db:test:neo4j:up` (compose.test.neo4j.yml); CI's HTTP job runs it as a
 * service. The graph is read the way production reads it (AIO-1167): straight from Neo4j, every fact
 * kept only when EVERY source episode resolves to an item in that fact's own partition — never through
 * Graphiti `/search`, whose captures must stay empty. Each test seeds provenance-linked facts under its
 * OWN team's partitions only, keyed to its real item ids, and deletes exactly those afterwards; the
 * shared test Neo4j is never wiped.
 *
 * What is asserted is the model INPUT the production route actually assembled (the captured user
 * message: `<structured_context>` — which carries the graph facts — and `<source>` blocks) — spec-derived
 * fixture truth, not parity:
 *   - a granted external-posture human: granted sourced + granted hand-entered tasks/decisions, the
 *     granted item's source block, and the fact proven by the granted item in the granted initiative's
 *     partition; never a hidden marker (including a fact that also cites the hidden item), never a
 *     General fact;
 *   - a legacy connector with a planted Everyone row: its BASELINE (hand-entered rows in both containers,
 *     actors + REPORTS_TO) and nothing sourced, no item sources, no graph facts;
 *   - an external legacy (offroster) key: nothing new, no graph facts;
 *   - an admitted Everyone human on a clean team (ready builtin partitions, no restriction debt): the
 *     POSITIVE control — it receives the General fact, so the legacy keys' absence of that same fact,
 *     on the same team and partition, is not vacuous.
 */

const llmUrl = inject("tierret1FakeLlmUrl");
const graphitiUrl = inject("tierret1FakeGraphitiUrl");
const neo4jTarget = inject("tierret1Neo4j");

const HIDDEN = "zirconmothhidden"; // appears only in content the external member must never receive
const SRC_HAND = "basaltwrenhand"; // a hand-entered row in the UNGRANTED ingest container
const ACTOR_A = "tierret1-actor-alpha";
const ACTOR_B = "tierret1-actor-beta";
const GRAPH_GRANTED = "garnetgraphgranted"; // a graph fact proven by the granted item, in its partition
const GRAPH_GENERAL = "jaspergraphgeneral"; // a graph fact proven by a General item, in General
const GRAPH_SECTION = "## Graph memory";

/* ── The isolated test Neo4j: seeded per test, under that test's own partitions, then cleaned ── */

let graphDriver: Driver | null = null;
const seededGroups = new Set<string>();

function graphDb(): Driver {
  graphDriver ??= neo4j.driver(neo4jTarget.url, neo4j.auth.basic(neo4jTarget.user, neo4jTarget.password));
  return graphDriver;
}

afterEach(async () => {
  if (seededGroups.size === 0) return;
  const groups = [...seededGroups];
  seededGroups.clear();
  const session = graphDb().session();
  try {
    // Only this suite's own partitions — never a blanket wipe of the shared test service.
    await session.run("MATCH (n) WHERE n.group_id IN $groups DETACH DELETE n", { groups });
  } finally {
    await session.close();
  }
});

afterAll(async () => {
  await graphDriver?.close();
});

/**
 * One fact exactly as Graphiti writes it and `readAuthorizedGraphFacts` reads it:
 * `(:Entity)-[:RELATES_TO {uuid, fact, created_at, group_id, episodes}]->(:Entity)` in `group`, its
 * `episodes` naming `(:Episodic {uuid, name: "items:<item-id>", group_id})` nodes in the same group.
 * Nothing here decides visibility: the route resolves each episode to its item and keeps the fact only
 * if every item is in `group`'s own project for this reader (Postgres), exactly as in production.
 */
async function seedGraphFact(group: string, fact: string, itemIds: readonly string[]): Promise<void> {
  seededGroups.add(group);
  const episodes = itemIds.map((itemId) => ({ uuid: `tierret1-ep-${randomUUID()}`, name: episodeName(itemId, 0, 1) }));
  const session = graphDb().session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `UNWIND $episodes AS ep
         CREATE (:Episodic {uuid: ep.uuid, name: ep.name, source: 'text', source_description: 'tierret1 fixture',
                            created_at: datetime(), group_id: $group})`,
        { episodes, group },
      );
      await tx.run(
        `CREATE (a:Entity:Person {uuid: $subject, name: 'Fixture Lead', group_id: $group})
         CREATE (b:Entity {uuid: $object, name: 'Fixture Topic', group_id: $group})
         CREATE (a)-[:RELATES_TO {uuid: $fact_id, name: 'RELATES_TO', fact: $fact, created_at: datetime(),
                                  group_id: $group, episodes: $episode_uuids}]->(b)`,
        {
          subject: `tierret1-entity-${randomUUID()}`, object: `tierret1-entity-${randomUUID()}`,
          fact_id: `tierret1-fact-${randomUUID()}`, fact, group, episode_uuids: episodes.map((e) => e.uuid),
        },
      );
    });
  } finally {
    await session.close();
  }
}

/** A built-in's partition, read from its STORED pointer (the access contract), never slug-derived. */
async function systemGroup(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db().from("projects").select("graph_group_id")
    .eq("team_id", seed.teamId).eq("slug", slug).eq("kind", "system").single();
  if (error || !(data as { graph_group_id: string | null } | null)?.graph_group_id) {
    throw new Error(`system partition missing for ${slug}: ${error?.message ?? "no pointer"}`);
  }
  return (data as { graph_group_id: string }).graph_group_id;
}

/** An initiative's per-project partition pointer — the id production mints for it. */
async function initiativeGroup(seed: Seed, projectId: string): Promise<string> {
  const group = projectGroupId(seed.teamId, projectId);
  const { error } = await db().from("projects").update({ graph_group_id: group }).eq("id", projectId).eq("team_id", seed.teamId);
  if (error) throw new Error(`initiative pointer failed: ${error.message}`);
  return group;
}

/**
 * Armed and read-ready (the leak suite's fixture shape): arming takes the arm-time snapshot, and its
 * ledger rows are marked landed so the readiness latch sets on the next enforced read. This is the
 * partition-READINESS precondition only — provenance is still checked per fact at read time.
 */
async function readyInitiative(seed: Seed, projectId: string, group: string): Promise<void> {
  const { armProjectsForPrincipal } = await import("@/lib/graph/arming");
  await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
  const { error } = await db().from("graph_episodes").update({ content_sha256: "tierret1-landed", episode_uuid: "tierret1-landed" })
    .eq("team_id", seed.teamId).eq("group_id", group);
  if (error) throw new Error(`readiness fixture failed: ${error.message}`);
}

async function reset(url: string): Promise<void> {
  expect((await fetch(`${url}/__fake/reset`, { method: "POST" })).status).toBe(200);
}
async function llmCaptured(): Promise<LlmCaptured> {
  return (await (await fetch(`${llmUrl}/__fake/captured`)).json()) as LlmCaptured;
}
async function graphCaptured(): Promise<GraphCaptured> {
  return (await (await fetch(`${graphitiUrl}/__fake/captured`)).json()) as GraphCaptured;
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** POST the real query route and drain the SSE stream to its end. */
async function query(seed: Seed, key: string, conversationId: string, question: string): Promise<{ status: number; events: SseEvent[]; failure: string }> {
  const res = await fetch(`${BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: keyHeaders(key, seed.teamSlug),
    body: JSON.stringify({ question, conversation_id: conversationId }),
  });
  const text = await res.text(); // the route closes the stream after `done` (or `error`)
  // A refusal is the route's JSON error envelope, not SSE: keep its code/message for the assertion
  // message (the envelope carries no raw exception detail by contract).
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return { status: res.status, events: [], failure: text.slice(0, 500) };
  }
  const events = text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event: ev, data: JSON.parse(raw) as unknown };
    });
  return { status: res.status, events, failure: "" };
}

/**
 * Run one query with both spies reset first; return the drained events, the ONE streamed model request
 * the route sent (its user message), and the graph searches it made.
 */
async function observe(seed: Seed, key: string, conversationId: string, question: string) {
  await reset(llmUrl);
  await reset(graphitiUrl);
  const { status, events, failure } = await query(seed, key, conversationId, question);
  expect(status, `/api/v1/query refused: ${failure}`).toBe(200);
  const names = events.map((e) => e.event);
  expect(names, "no error frame on the wire").not.toContain("error");
  expect(names, "drained through done").toContain("done");
  expect(names.indexOf("sources")).toBeLessThan(names.indexOf("done"));
  const answer = events.filter((e) => e.event === "delta").map((e) => (e.data as { text: string }).text).join("");
  expect(answer, "the fake's streamed answer reached the client").toBe(FAKE_ANSWER);
  const done = events.find((e) => e.event === "done")!.data as { provider: string; model: string; input_tokens: number; output_tokens: number };
  expect(done, "the LOCAL backend answered, with the fake's usage").toMatchObject({ provider: "local", model: FAKE_MODEL, input_tokens: 11, output_tokens: 5 });

  const llm = await llmCaptured();
  expect(llm.anthropicTrap, "never fell back to Anthropic").toEqual([]);
  expect(llm.unexpected).toEqual([]);
  const streamed = llm.chat.filter((c) => c.body.stream === true);
  expect(streamed, "exactly one streamed answer request reached the loopback endpoint").toHaveLength(1);
  expect(streamed[0].body.model).toBe(FAKE_MODEL);
  expect(streamed[0].authorization ?? "", "no real credential reached the fake").toMatch(/^Bearer( local)?\s*$/); // fetch trims the blanked key's trailing space
  const user = streamed[0].body.messages?.find((m) => m.role === "user")?.content ?? "";
  expect(user, "the captured user message carries the structured context").toContain("<structured_context>");
  const structured = user.slice(user.indexOf("<structured_context>"), user.indexOf("</structured_context>"));
  const graph = await graphCaptured();
  // Graph reads go to Neo4j with provenance checks; Graphiti's provenance-free /search is never used.
  expect(graph.search, "no Graphiti /search request — graph facts come only from the Neo4j read").toEqual([]);
  return { user, structured };
}

async function rawMember(seed: Seed, over: Partial<{ kind: string; tier: string; is_connector: boolean }>): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Legacy",
      actor_handle: `l-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function plantEveryone(seed: Seed, memberId: string): Promise<void> {
  const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").eq("is_builtin", true).single();
  const { error } = await db().from("group_members").insert({ team_id: seed.teamId, group_id: (everyone as { id: string }).id, member_id: memberId });
  if (error) throw new Error(`everyone row failed: ${error.message}`);
}

async function answerLocally(seed: Seed): Promise<void> {
  const { error } = await db().from("teams").update({ answering_provider: "local" }).eq("id", seed.teamId);
  if (error) throw new Error(`answering_provider seed failed: ${error.message}`);
}

/** A member-owned conversation, so the route continues it (no first-turn title generation). */
async function conversation(seed: Seed, memberId: string): Promise<string> {
  const c = await createConversation(db(), { teamId: seed.teamId, memberId }, "tierret1 query");
  return c!.id;
}

async function key(seed: Seed, memberId: string, label: string): Promise<{ key: string; conversationId: string }> {
  return { key: (await issueApiKey(db(), seed.teamId, memberId, label)).key, conversationId: await conversation(seed, memberId) };
}

async function mkInitiative(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`project seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Fixture-only custom placement (the spec's AC-01 shape: no product curation endpoint exists). */
async function place(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual" });
  if (error) throw new Error(`placement failed: ${error.message}`);
}

async function insertRows(table: "tasks" | "decisions", rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) {
    const { error } = await db().from(table).insert(row);
    if (error) throw new Error(`${table} seed failed: ${error.message}`);
  }
}

async function seedOrgStructure(seed: Seed): Promise<void> {
  for (const [id, name] of [[ACTOR_A, "Alpha Marker"], [ACTOR_B, "Beta Marker"]] as const) {
    const { error } = await db().from("graph_entities").insert({ team_id: seed.teamId, entity_id: id, entity_type: "actor", name, attrs: { role: "lead" } });
    if (error) throw new Error(`actor seed failed: ${error.message}`);
  }
  const { error } = await db().from("graph_relationships").insert({ team_id: seed.teamId, from_id: ACTOR_A, to_id: ACTOR_B, relationship_type: "REPORTS_TO" });
  if (error) throw new Error(`relationship seed failed: ${error.message}`);
}

describe("TIERRET-1 over HTTP — /api/v1/query model input and graph scope (fake loopback provider)", () => {
  it("granted external human: granted items/tasks/decisions and its granted graph fact reach the model, hidden markers and General facts never do; legacy keys gain nothing and receive no graph facts", async () => {
    const seed = await seedTeam();
    await answerLocally(seed);
    const granted = await ingest(seed, { path: "granted.md", body: "granted wire body obsidianquill", access: "team", project: "src" });
    const hidden = await ingest(seed, { path: "hidden.md", body: `hidden wire body ${HIDDEN}`, access: "team", project: "src" });
    // Stays in General: the provenance behind the General fact an Everyone member could read.
    const general = await ingest(seed, { path: "general.md", body: "general wire body lapisgeneral", access: "team", project: "src" });
    await convergeTeam(seed);
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const X = await mkInitiative(seed, "qx");
    const Y = await mkInitiative(seed, "qy");
    const groupX = await initiativeGroup(seed, X);
    const groupY = await initiativeGroup(seed, Y);
    await place(seed, granted.id, X);
    await place(seed, hidden.id, Y);
    await readyInitiative(seed, X, groupX);
    const src = granted.projectId!;
    const today = new Date().toISOString().slice(0, 10);
    await insertRows("tasks", [
      { team_id: seed.teamId, project_id: src, row_key: "QX-1", title: "granted sourced task", assignee: "T", status: "in_progress", audience: "team", origin: "sync", source_item_id: granted.id },
      { team_id: seed.teamId, project_id: src, row_key: "QY-1", title: `${HIDDEN} sourced task`, assignee: "T", status: "in_progress", audience: "team", origin: "sync", source_item_id: hidden.id },
      { team_id: seed.teamId, project_id: X, row_key: "QH-1", title: "granted hand task", assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: seed.memberId },
      { team_id: seed.teamId, project_id: src, row_key: "QS-1", title: `${SRC_HAND} task`, assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: seed.memberId },
    ]);
    await insertRows("decisions", [
      { team_id: seed.teamId, project_id: src, row_key: "QDX-1", title: "granted sourced decision", decided_by: "t", decided_at: today, still_valid: true, audience: "team", source_item_id: granted.id },
      { team_id: seed.teamId, project_id: src, row_key: "QDY-1", title: `${HIDDEN} decision`, decided_by: "t", decided_at: today, still_valid: true, audience: "team", source_item_id: hidden.id },
      { team_id: seed.teamId, project_id: X, row_key: "QDH-1", title: "granted hand decision", decided_by: "t", decided_at: today, still_valid: true, audience: "team", source_item_id: null, created_by: seed.memberId },
    ]);
    await seedOrgStructure(seed);

    // The external collaborator: production creation path (builtin External only) + a deliberate grant.
    const ext = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Ext", actorHandle: `e-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
    await db().from("members").update({ status: "active" }).eq("id", ext.id);
    const g = await createGroup(db(), seed.teamId, `qx-${randomUUID().slice(0, 6)}`, "QX", seed.memberId);
    expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, ext.id, seed.memberId)).ok).toBe(true);
    expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);
    const gy = await createGroup(db(), seed.teamId, `qy-${randomUUID().slice(0, 6)}`, "QY", seed.memberId);
    expect((await grantProjectToGroup(db(), seed.teamId, Y, gy.groupId!, seed.memberId)).ok).toBe(true);
    const connector = await rawMember(seed, { is_connector: true });
    await plantEveryone(seed, connector);
    const offroster = await rawMember(seed, { kind: "offroster", tier: "external" });
    // The roster writes above leave identity attribution repair pending, and the graph read's
    // authorization epoch rightly refuses to serve until it converges (the route's fail-closed 503).
    await convergeIdentityAttribution(seed);

    // Provenance-linked graph facts, each in a real partition of this team and cited by real items.
    const generalGroup = await systemGroup(seed, GENERAL_SLUG);
    await seedGraphFact(groupX, `Fixture Lead owns the granted wire body ${GRAPH_GRANTED}`, [granted.id]);
    // In the GRANTED partition, but also citing the hidden item, which is not in that partition.
    await seedGraphFact(groupX, `Fixture Lead merged the granted wire body with ${HIDDEN} laundered`, [granted.id, hidden.id]);
    await seedGraphFact(groupY, `Fixture Lead keeps the hidden wire body ${HIDDEN} graph`, [hidden.id]);
    await seedGraphFact(generalGroup, `Fixture Lead edits the general wire body ${GRAPH_GENERAL}`, [general.id]);

    const question = "What does the granted wire body say?";

    // 1. Granted external-posture human: the membership-only member rule, on the model's actual input.
    const E = await key(seed, ext.id, "ext");
    const e = await observe(seed, E.key, E.conversationId, question);
    for (const k of ["QX-1", "QH-1", "QDX-1", "QDH-1"]) expect(e.structured, `${k}: granted row reaches the model`).toContain(k);
    for (const k of ["QY-1", "QS-1", "QDY-1"]) expect(e.structured, `${k}: ungranted row never reaches the model`).not.toContain(k);
    expect(e.user, "the granted TEAM-labelled item is a source block").toMatch(/<source id="S\d+" [^>]*path="granted\.md"/);
    expect(e.user).toContain("obsidianquill");
    expect(e.user, "the hidden item is not a source block").not.toContain('path="hidden.md"');
    expect(e.user, "no hidden marker anywhere in the model input").not.toContain(HIDDEN);
    expect(e.user).not.toContain(SRC_HAND);
    // The graph leg, read from Neo4j: the fact its granted item proves in the granted partition…
    expect(e.structured, "the granted partition's proven fact reaches the model").toContain(GRAPH_GRANTED);
    expect(e.structured).toContain(GRAPH_SECTION);
    // …never the fact that also cites the hidden item (asserted by the HIDDEN check above, which covers
    // it and the hidden partition's fact), and never General's: General is not in this member's scope.
    expect(e.user, "an external member never receives a General graph fact").not.toContain(GRAPH_GENERAL);

    // 2. Legacy connector WITH a planted Everyone row: baseline preserved (hand-entered rows in BOTH
    //    containers + org structure), nothing sourced, no item sources, no graph scope.
    const C = await key(seed, connector, "connector");
    const c = await observe(seed, C.key, C.conversationId, question);
    for (const k of ["QH-1", "QS-1", "QDH-1"]) expect(c.structured, `${k}: baseline legacy hand-entered row kept`).toContain(k);
    for (const k of ["QX-1", "QY-1", "QDX-1", "QDY-1"]) expect(c.structured, `${k}: a connector gains no sourced row`).not.toContain(k);
    expect(c.structured, "baseline actors leg kept").toContain(`${ACTOR_A}: Alpha Marker`);
    expect(c.structured, "baseline REPORTS_TO leg kept").toContain(`${ACTOR_A} REPORTS_TO ${ACTOR_B}`);
    expect(c.user, "no item source for a non-principal").toContain("<no document sources matched>");
    expect(c.user).not.toContain("obsidianquill");
    expect(c.user).not.toContain(HIDDEN);
    for (const marker of [GRAPH_GRANTED, GRAPH_GENERAL, GRAPH_SECTION]) {
      expect(c.user, `legacy connector: no graph scope (${marker})`).not.toContain(marker);
    }

    // 3. External legacy (offroster): nothing new — no sourced, no hand-entered, no items, no graph.
    const O = await key(seed, offroster, "offroster");
    const o = await observe(seed, O.key, O.conversationId, question);
    for (const k of ["QX-1", "QY-1", "QH-1", "QS-1", "QDX-1", "QDY-1", "QDH-1"]) expect(o.structured, `${k}: offroster gains nothing`).not.toContain(k);
    expect(o.structured, "baseline actors leg (pre-existing, not a gain)").toContain(`${ACTOR_A}: Alpha Marker`);
    expect(o.user).toContain("<no document sources matched>");
    expect(o.user).not.toContain("obsidianquill");
    expect(o.user).not.toContain(HIDDEN);
    for (const marker of [GRAPH_GRANTED, GRAPH_GENERAL, GRAPH_SECTION]) {
      expect(o.user, `offroster: no graph scope (${marker})`).not.toContain(marker);
    }
  });

  it("graph scope: an admitted Everyone human on a clean team receives the ready General partition's proven fact; legacy connector/offroster keys receive no graph facts", async () => {
    // Readiness shape reused from enfb-graph-query-scope (ingest → bootstrap → backfill, no moves out
    // of General, so no restriction debt): the builtin partition is served by its stored pointer.
    const seed = await seedTeam();
    await answerLocally(seed);
    const g = await ingest(seed, { path: "g.md", body: "graph seed body tourmalinekite", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await convergeTeam(seed);
    const connector = await rawMember(seed, { is_connector: true });
    await plantEveryone(seed, connector);
    const offroster = await rawMember(seed, { kind: "offroster", tier: "external" });
    await convergeIdentityAttribution(seed);
    await seedGraphFact(await systemGroup(seed, GENERAL_SLUG), `Fixture Lead curates the tourmalinekite graph seed ${GRAPH_GENERAL}`, [g.id]);
    const question = "What does the tourmalinekite graph seed say?";

    const M = await key(seed, seed.memberId, "everyone");
    const m = await observe(seed, M.key, M.conversationId, question);
    expect(m.structured, "POSITIVE control: the General partition's proven fact reaches an admitted member").toContain(GRAPH_GENERAL);
    expect(m.structured).toContain(GRAPH_SECTION);

    for (const [id, label] of [[connector, "connector"], [offroster, "offroster"]] as const) {
      const L = await key(seed, id, label);
      const l = await observe(seed, L.key, L.conversationId, question);
      expect(l.user, `${label}: a legacy key acquires no graph scope`).not.toContain(GRAPH_GENERAL);
      expect(l.user).not.toContain(GRAPH_SECTION);
    }
  });
});
