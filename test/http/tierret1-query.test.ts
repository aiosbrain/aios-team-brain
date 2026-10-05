import { randomUUID } from "node:crypto";
import { describe, expect, inject, it } from "vitest";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { createConversation } from "@/lib/chat/store";
import { ingest } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam, db, keyHeaders, seedTeam, type Seed } from "./http-helpers";
import { FAKE_ANSWER, FAKE_MODEL, type GraphCaptured, type LlmCaptured } from "./fake-providers";

/**
 * TIERRET-1 AC-03 / AC-05 / AC-11 — the REAL `/api/v1/query` route over a real socket (`next start` +
 * the shared test Postgres), drained through `done`. OPT-IN: runs only under
 * `vitest.tierret1-query.config.ts`, whose global setup pins the server's LLM_BASE_URL to a test-only
 * loopback fake OpenAI-compatible endpoint and GRAPHITI_URL to a loopback /search spy, with every cloud
 * credential blanked and ANTHROPIC_BASE_URL pointed at a recorded trap. No paid or external call.
 *
 * What is asserted is the model INPUT the production route actually assembled (the captured user
 * message: `<structured_context>` + `<source>` blocks) and the graph partitions it actually searched —
 * spec-derived fixture truth, not parity:
 *   - a granted external-posture human: granted sourced + granted hand-entered tasks/decisions and the
 *     granted item's source block; no hidden markers; never the General graph partition;
 *   - a legacy connector with a planted Everyone row: its BASELINE (hand-entered rows in both containers,
 *     actors + REPORTS_TO) and nothing sourced, no item sources, zero graph searches;
 *   - an external legacy (offroster) key: nothing new, zero graph searches;
 *   - an admitted Everyone human on a clean team (ready builtin partitions, no restriction debt): the
 *     POSITIVE control proving the /search spy is live — so the legacy zeros are not vacuous.
 */

const llmUrl = inject("tierret1FakeLlmUrl");
const graphitiUrl = inject("tierret1FakeGraphitiUrl");

const HIDDEN = "zirconmothhidden"; // appears only in content the external member must never receive
const SRC_HAND = "basaltwrenhand"; // a hand-entered row in the UNGRANTED ingest container
const ACTOR_A = "tierret1-actor-alpha";
const ACTOR_B = "tierret1-actor-beta";

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
async function query(seed: Seed, key: string, conversationId: string, question: string): Promise<{ status: number; events: SseEvent[] }> {
  const res = await fetch(`${BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: keyHeaders(key, seed.teamSlug),
    body: JSON.stringify({ question, conversation_id: conversationId }),
  });
  const text = await res.text(); // the route closes the stream after `done` (or `error`)
  const events = text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event: ev, data: JSON.parse(raw) as unknown };
    });
  return { status: res.status, events };
}

/**
 * Run one query with both spies reset first; return the drained events, the ONE streamed model request
 * the route sent (its user message), and the graph searches it made.
 */
async function observe(seed: Seed, key: string, conversationId: string, question: string) {
  await reset(llmUrl);
  await reset(graphitiUrl);
  const { status, events } = await query(seed, key, conversationId, question);
  expect(status).toBe(200);
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
  return { user, structured, graph: await graphCaptured() };
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
  it("granted external human: granted items/tasks/decisions reach the model, hidden markers never do; legacy keys gain nothing and never search the graph", async () => {
    const seed = await seedTeam();
    await answerLocally(seed);
    const granted = await ingest(seed, { path: "granted.md", body: "granted wire body obsidianquill", access: "team", project: "src" });
    const hidden = await ingest(seed, { path: "hidden.md", body: `hidden wire body ${HIDDEN}`, access: "team", project: "src" });
    await convergeTeam(seed);
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const X = await mkInitiative(seed, "qx");
    const Y = await mkInitiative(seed, "qy");
    await place(seed, granted.id, X);
    await place(seed, hidden.id, Y);
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
    for (const s of e.graph.search) {
      expect(s.group_ids, "an external member's graph scope never includes General").not.toContain(`${seed.teamSlug}_team`);
    }

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
    expect(c.graph.search, "legacy connector: zero graph searches").toEqual([]);

    // 3. External legacy (offroster): nothing new — no sourced, no hand-entered, no items, no graph.
    const O = await key(seed, offroster, "offroster");
    const o = await observe(seed, O.key, O.conversationId, question);
    for (const k of ["QX-1", "QY-1", "QH-1", "QS-1", "QDX-1", "QDY-1", "QDH-1"]) expect(o.structured, `${k}: offroster gains nothing`).not.toContain(k);
    expect(o.structured, "baseline actors leg (pre-existing, not a gain)").toContain(`${ACTOR_A}: Alpha Marker`);
    expect(o.user).toContain("<no document sources matched>");
    expect(o.user).not.toContain("obsidianquill");
    expect(o.graph.search, "offroster: zero graph searches").toEqual([]);
  });

  it("graph scope: an admitted Everyone human on a clean team searches the ready General partition (spy live); legacy connector/offroster keys make zero searches", async () => {
    // Readiness shape reused from enfb-graph-query-scope (ingest → bootstrap → backfill, no moves out
    // of General, so no restriction debt): the builtin partition is served by its stored pointer.
    const seed = await seedTeam();
    await answerLocally(seed);
    await ingest(seed, { path: "g.md", body: "graph seed body tourmalinekite", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await convergeTeam(seed);
    const connector = await rawMember(seed, { is_connector: true });
    await plantEveryone(seed, connector);
    const offroster = await rawMember(seed, { kind: "offroster", tier: "external" });
    const question = "What does the tourmalinekite graph seed say?";

    const M = await key(seed, seed.memberId, "everyone");
    const m = await observe(seed, M.key, M.conversationId, question);
    expect(m.graph.search.length, "POSITIVE control: the /search spy is live for an admitted member").toBeGreaterThan(0);
    expect(m.graph.search.flatMap((s) => s.group_ids), "the ready builtin General partition is searched").toContain(`${seed.teamSlug}_team`);

    for (const [id, label] of [[connector, "connector"], [offroster, "offroster"]] as const) {
      const L = await key(seed, id, label);
      const l = await observe(seed, L.key, L.conversationId, question);
      expect(l.graph.search, `${label}: a legacy key acquires no graph scope`).toEqual([]);
    }
  });
});
