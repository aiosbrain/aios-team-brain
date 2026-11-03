import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pg/pool";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { getSessionUser } from "@/lib/auth/session";
import { serverClient } from "@/lib/db/server";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { convergeIdentityAttribution, db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 (r30, A1) — what the two query routes put in front of the model while an attribution
 * repair is pending, at the CONTENT level (real Postgres).
 *
 * Ruling. Query context carries no identity-MAPPED credit: `decisions.decided_by` and
 * `tasks.assignee` are raw labels from the source system or a manual entry, rendered verbatim, and
 * the only `items.member_id`-derived legs (the git and per-person activity digests) are permanently
 * omitted. So a pending remap/unlink does not take the query routes down — and this file proves the
 * consequence instead of the status: during the pending window the model context, the deterministic
 * answer built from it, and every row the turn persists
 *   · never name the member whose credit the mapping is moving (stale mapped contribution credit), and
 *   · still carry the legitimate source and manual labels — on the recency decision leg, the OLDER
 *     keyword-matched decision leg, and the task leg.
 * The refusal gates are unchanged: graph authorization unavailable is still a 503 with no turn trace,
 * and an unauthenticated or non-member caller writes nothing.
 *
 * Only the Neo4j transport, the model and the title generator are controlled (plus the dashboard
 * session identity). The model is a deterministic echo of the context lines that carry a label or
 * the moved member's name, so whatever reached the model is exactly what the saved answer shows.
 */

const MOVED_MEMBER = "Remapped Contributor Quinn";
const SENTINEL = "verdigrisledger";
const LABELS = {
  recentSourceDecision: "Source Label Dana",
  olderManualDecision: "Older Manual Label Kim",
  olderSourceDecision: "Older Source Label Sam",
  sourceAssignee: "Source Assignee Ray",
  manualAssignee: "Manual Assignee Lee",
} as const;
const ECHO = /Dana|Kim|Sam|Ray|Lee|Quinn/;

const probe = vi.hoisted(() => ({
  graphReads: 0,
  answers: 0,
  titles: 0,
  graphDown: false,
  contexts: [] as unknown[],
}));

vi.mock("@/lib/graph/neo4j", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/neo4j")>()),
  neo4jConfigured: () => true,
  runRead: async () => {
    probe.graphReads += 1;
    if (probe.graphDown) throw new Error("neo4j unreachable");
    return [];
  },
}));
vi.mock("@/lib/query/claude", () => ({
  async *streamAnswer(ctx: { structured: string }) {
    probe.answers += 1;
    probe.contexts.push(ctx);
    // Deterministic answer: every context line that carries a label or the moved member's name.
    yield { type: "delta" as const, text: ctx.structured.split("\n").filter((line) => ECHO.test(line)).join("\n") };
    yield {
      type: "done" as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0, provider: "test", model: "test", estimated: false },
    };
  },
}));
vi.mock("@/lib/chat/title", () => ({
  generateAndSetTitle: async () => {
    probe.titles += 1;
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

beforeEach(() => {
  probe.graphReads = 0;
  probe.answers = 0;
  probe.titles = 0;
  probe.graphDown = false;
  probe.contexts = [];
  // The graph leg runs only behind a configured Graphiti; its reads go to the controlled transport.
  vi.stubEnv("GRAPHITI_URL", "http://graphiti.test");
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(serverClient).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function repairStatus(seed: Seed): Promise<string> {
  const { rows } = await getPool().query<{ repair_status: string }>(
    `select repair_status from team_identity_authority where team_id=$1`, [seed.teamId]);
  return rows[0]?.repair_status ?? "complete";
}

type Fixture = { seed: Seed; key: string; moved: string; movedEmail: string; externalId: string };

/**
 * A graph-scoped member with an API key and a session, plus:
 *   · an item whose `items.member_id` credits a SECOND member (the credit a mapping change moves);
 *   · a recent SOURCED decision and two tasks (one sourced, one hand-entered) carrying raw labels;
 *   · two OLD decisions (one hand-entered, one sourced) matching a sentinel, pushed out of the
 *     recency-50 window by 50 newer decisions, so only the keyword-matched leg can surface them.
 */
async function labelledTeam(): Promise<Fixture> {
  const seed = await seedTeam();
  const teamItem = await ingest(seed, { path: "team.md", body: "team payments ledger", access: "team", project: "src" });
  const projectId = teamItem.projectId!;

  const movedEmail = `${randomUUID()}@test.local`;
  const { data: movedRow, error: movedErr } = await db().from("members").insert({
    team_id: seed.teamId, email: movedEmail, display_name: MOVED_MEMBER,
    actor_handle: `q-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  if (movedErr || !movedRow) throw new Error(`member seed failed: ${movedErr?.message}`);
  const moved = (movedRow as { id: string }).id;
  const credited = await ingest(seed, {
    path: "ledger-work.md", body: "ledger reconciliation work", access: "team", project: "src",
    frontmatter: { source: "slack" },
  });
  // Mapped contribution credit: the item is the moved member's by `items.member_id`.
  await getPool().query(`update items set member_id=$1 where id=$2 and team_id=$3`, [moved, credited.id, seed.teamId]);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const decisions = [
    { row_key: "QD-1", title: "Adopt the ledger format", decided_by: LABELS.recentSourceDecision, decided_at: today,
      source_item_id: teamItem.id, created_by: null },
    { row_key: "QDO-1", title: "Old ledger ruling", decided_by: LABELS.olderManualDecision, decided_at: "2020-01-01",
      rationale: `because ${SENTINEL}`, source_item_id: null, created_by: seed.memberId },
    { row_key: "QDO-2", title: "Old ledger exception", decided_by: LABELS.olderSourceDecision, decided_at: "2020-01-02",
      rationale: `because ${SENTINEL}`, source_item_id: teamItem.id, created_by: null },
    ...Array.from({ length: 50 }, (_, i) => ({
      row_key: `QDF-${i}`, title: `Filler ${i}`, decided_by: "", decided_at: yesterday,
      source_item_id: teamItem.id, created_by: null,
    })),
    // One key set for every row: a multi-row insert takes its column list from the first row.
  ].map((d) => ({ team_id: seed.teamId, project_id: projectId, still_valid: true, audience: "team", rationale: "", ...d }));
  expect((await db().from("decisions").insert(decisions)).error).toBeNull();
  const tasks = [
    { row_key: "QS-1", title: "Ledger migration", assignee: LABELS.sourceAssignee, origin: "sync",
      source_item_id: teamItem.id, created_by: null },
    { row_key: "QM-1", title: "Ledger cutover checklist", assignee: LABELS.manualAssignee, origin: "ui",
      source_item_id: null, created_by: seed.memberId },
  ].map((t) => ({ team_id: seed.teamId, project_id: projectId, status: "in_progress", audience: "team", ...t }));
  expect((await db().from("tasks").insert(tasks)).error).toBeNull();

  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await backfillTeamContext(db(), seed.teamId);
  await convergeIdentityAttribution(seed);
  const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "query-context-attribution-labels");
  const authUserId = randomUUID();
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [authUserId, `${randomUUID()}@test.local`]);
  // auth_user_id is not an attribution dependency: this binding leaves the repair complete.
  await getPool().query(`update members set auth_user_id=$1 where id=$2 and team_id=$3`, [authUserId, seed.memberId, seed.teamId]);
  vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId } as Awaited<ReturnType<typeof getSessionUser>>);
  vi.mocked(serverClient).mockResolvedValue(db() as unknown as Awaited<ReturnType<typeof serverClient>>);
  expect(await repairStatus(seed)).toBe("complete");
  return { seed, key, moved, movedEmail, externalId: `U_${randomUUID().slice(0, 8)}` };
}

/** Every row a turn could create or touch, as content, so an UPDATE shows as well as an INSERT. */
async function turnState(seed: Seed) {
  const { rows } = await getPool().query(
    `select
       (select coalesce(string_agg(id::text||'|'||title||'|'||updated_at::text, ',' order by id), '')
          from conversations where team_id=$1) as conversations,
       (select coalesce(string_agg(id::text||'|'||role, ',' order by id), '')
          from chat_messages where team_id=$1) as messages,
       (select coalesce(string_agg(id::text||'|'||status, ',' order by id), '')
          from chat_turn_runs where team_id=$1) as runs,
       (select coalesce(string_agg(id::text||'|'||answer_preview||'|'||cost_usd::text, ',' order by id), '')
          from query_log where team_id=$1) as query_log`,
    [seed.teamId],
  );
  return rows[0] as { conversations: string; messages: string; runs: string; query_log: string };
}

async function savedAnswer(seed: Seed): Promise<{ message: string; preview: string }> {
  const { rows } = await getPool().query<{ message: string | null; preview: string | null }>(
    `select
       (select content from chat_messages where team_id=$1 and role='assistant'
         order by created_at desc, id desc limit 1) as message,
       (select answer_preview from query_log where team_id=$1
         order by created_at desc, id desc limit 1) as preview`,
    [seed.teamId],
  );
  return { message: rows[0]?.message ?? "", preview: rows[0]?.preview ?? "" };
}

type Route = "v1" | "dashboard";
const QUESTION = `who decided ${SENTINEL} and who owns the ledger migration?`;

async function ask(route: Route, seed: Seed, key: string): Promise<Response> {
  if (route === "v1") {
    const { POST } = await import("@/app/api/v1/query/route");
    return POST(new Request("http://test/api/v1/query", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "X-AIOS-Team": seed.teamSlug, "content-type": "application/json" },
      body: JSON.stringify({ question: QUESTION }),
    }) as unknown as NextRequest);
  }
  const { POST } = await import("@/app/api/dashboard/query/route");
  return POST(new Request("http://test/api/dashboard/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: seed.teamSlug, question: QUESTION }),
  }) as unknown as NextRequest);
}

/** The full content-level contract for one answered turn during a pending repair. */
async function expectLabelsWithoutMovedCredit(route: Route, f: Fixture, phase: string) {
  expect(await repairStatus(f.seed), `${phase}: the repair is pending`).toBe("pending");
  const contextsBefore = probe.contexts.length;

  const res = await ask(route, f.seed, f.key);
  expect(res.status, phase).toBe(200);
  const wire = await res.text();
  expect(probe.contexts.length, `${phase}: the model was reached once`).toBe(contextsBefore + 1);
  expect(probe.graphReads, `${phase}: the graph leg ran`).toBeGreaterThan(0);

  const ctx = probe.contexts[probe.contexts.length - 1] as { structured: string };
  const everything = JSON.stringify(ctx);
  // Stale mapped contribution credit: nothing the mapping is moving reaches the model.
  for (const stale of [MOVED_MEMBER, f.movedEmail, f.moved, "## Activity by person", "## Git activity"]) {
    expect(everything, `${phase}: model context must not carry ${stale}`).not.toContain(stale);
  }
  // Legitimate raw labels are served verbatim on every leg.
  const [recency, older = ""] = ctx.structured.split("## Older decisions matching this query");
  expect(recency, phase).toContain(`#QD-1 `);
  expect(recency, phase).toContain(`— by ${LABELS.recentSourceDecision}`);
  expect(recency, `${phase}: non-vacuity — the recency window lost the old decisions`).not.toContain("#QDO-1 ");
  expect(recency, phase).not.toContain("#QDO-2 ");
  expect(older, `${phase}: the older matched-decision leg keeps the manual label`).toMatch(
    new RegExp(`#QDO-1 .*— by ${LABELS.olderManualDecision}`));
  expect(older, `${phase}: the older matched-decision leg keeps the source label`).toMatch(
    new RegExp(`#QDO-2 .*— by ${LABELS.olderSourceDecision}`));
  expect(ctx.structured, phase).toContain(`QS-1 [in_progress] Ledger migration (${LABELS.sourceAssignee}, `);
  expect(ctx.structured, phase).toContain(`QM-1 [in_progress] Ledger cutover checklist (${LABELS.manualAssignee}, `);

  // The deterministic answer streamed and saved is what the context carried — labels, no moved credit.
  const saved = await savedAnswer(f.seed);
  for (const [where, text] of [["wire", wire], ["saved message", saved.message], ["query_log preview", saved.preview]] as const) {
    expect(text, `${phase}: ${where}`).not.toContain(MOVED_MEMBER);
    expect(text, `${phase}: ${where}`).toContain(LABELS.recentSourceDecision);
  }
  for (const label of Object.values(LABELS)) {
    expect(saved.message, `${phase}: saved message keeps ${label}`).toContain(label);
  }
}

describe("AIO-1167 A1: query context during a pending remap/unlink is label-only (real Postgres)", () => {
  it.each(["v1", "dashboard"] as const)(
    "%s: remap and unlink keep raw source/manual labels and never serve the moved member's credit",
    async (route) => {
      const f = await labelledTeam();

      // Remap: link a provider identity to the credited member — a mapping change on a team with
      // items, so the repair goes pending and the credit is in motion.
      await setMemberIdentity(db(), f.seed.teamId, f.moved, { provider: "slack", externalId: f.externalId });
      await expectLabelsWithoutMovedCredit(route, f, "remap");

      // Unlink the same identity: pending again, same contract.
      await removeMemberIdentity(db(), f.seed.teamId, { provider: "slack", externalId: f.externalId });
      await expectLabelsWithoutMovedCredit(route, f, "unlink");
    },
  );

  it.each(["v1", "dashboard"] as const)(
    "%s: graph authorization unavailable during a pending remap is still the 503, with no turn trace",
    async (route) => {
      const f = await labelledTeam();
      await setMemberIdentity(db(), f.seed.teamId, f.moved, { provider: "slack", externalId: f.externalId });
      expect(await repairStatus(f.seed)).toBe("pending");
      probe.graphDown = true;
      const before = await turnState(f.seed);

      const res = await ask(route, f.seed, f.key);
      const text = await res.text();

      expect(res.status).toBe(503);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "temporarily_unavailable",
          message: "query context is temporarily unavailable; retry shortly",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      });
      expect(text).not.toContain(MOVED_MEMBER);
      expect(await turnState(f.seed)).toEqual(before);
      expect(probe.graphReads).toBeGreaterThan(0);
      expect(probe.answers).toBe(0);
      expect(probe.titles).toBe(0);
    },
  );

  it("an unauthenticated key and a non-member session are refused during a pending repair, writing nothing", async () => {
    const f = await labelledTeam();
    await setMemberIdentity(db(), f.seed.teamId, f.moved, { provider: "slack", externalId: f.externalId });
    expect(await repairStatus(f.seed)).toBe("pending");
    const before = await turnState(f.seed);

    const badKey = await ask("v1", f.seed, "aios_notakey_notasecret");
    expect(badKey.status).toBe(401);
    expect(await badKey.text()).not.toContain(MOVED_MEMBER);

    // A signed-in user bound to no member of this team.
    vi.mocked(getSessionUser).mockResolvedValue({ id: randomUUID() } as Awaited<ReturnType<typeof getSessionUser>>);
    const stranger = await ask("dashboard", f.seed, f.key);
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).not.toContain(MOVED_MEMBER);

    expect(await turnState(f.seed)).toEqual(before);
    expect(probe.graphReads).toBe(0);
    expect(probe.answers).toBe(0);
    expect(probe.titles).toBe(0);
  });
});
