import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AUDITFIX-1 AC5 — the leak proof at the ROUTE, not at the library.
 *
 * ⚠️ AUDITFIX-7 DELIBERATELY REVERSED HALF OF THIS FILE'S ORIGINAL ASSERTION, under an explicit
 * product ruling (Chetan, 2026-08-22): an agent granted a project SHOULD read what a person typed
 * into that project by hand. AUDITFIX-1 closed the hand-typed arm for EVERY token because scope was
 * being ignored entirely — an empty-scoped token received the whole team's hand-typed rows. The arm
 * is now GATED on the token's effective project set rather than closed, so:
 *   IN-scope hand-entered rows are SERVED (the ruling), and
 *   OUT-OF-scope hand-entered rows are still ABSENT (AUDITFIX-1's actual protection, kept).
 * The original test seeded its hand-entered rows INSIDE the token's scope, so it could only ever
 * express the closed rule. It is converted, not deleted: the leak it proves is still proven, by the
 * out-of-scope half.
 *
 * Everything else in this slice calls `retrieve`/`matchingDecisions` directly and hands them a
 * `principal` the test itself chose. That proves the predicate, and proves nothing about whether the
 * shipped route reaches it: the reproduced CRITICAL was a real `POST /api/v1/query` disclosure, and
 * the route builds its own enforcement view (`route.ts` — `enforce = { visibleItemIds: ids,
 * principal: "token" }`). This test puts the assertion behind real authentication of a minted
 * `aiosd_` bearer, the route's own principal assignment, and real retrieval.
 *
 * WHY NOT THE HTTP TIER (spec review round 2 killed that version): minting works there, but the http
 * tier has no LLM configured, the route never puts `ctx.structured` on the wire (only deltas and
 * cited sources), and the existing socket test cancels the body right after asserting 200 — so a
 * still-leaking implementation passes it. `streamAnswer` is the ONLY thing stubbed here, and it is
 * stubbed precisely because it is the one component that would otherwise need a model: it is also
 * the exact seam where `ctx.structured` is handed to the prompt (lib/query/claude.ts:303), which
 * makes it the right place to capture what the token was actually about to be told.
 */

/** Captures the ctx the route hands the answerer — i.e. what would reach the model's prompt. */
const captured: { structured: string[] } = { structured: [] };

vi.mock("@/lib/query/claude", () => ({
  async *streamAnswer(ctx: { structured: string }) {
    captured.structured.push(ctx.structured ?? "");
    yield { type: "delta" as const, text: "ok" };
    yield { type: "done" as const, usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } };
  },
}));

const TERM = "zanzibarite";

async function seedMember(seed: Seed, over: Partial<{ kind: string; tier: string }> = {}): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      display_name: `m-${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@test.local`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`, // not-null in `members`
      role: "member",
      status: "active",
      kind: over.kind ?? "human",
      tier: over.tier ?? "team",
    })
    .select("id")
    .single();
  if (error) throw new Error(`member seed failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function curateInto(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db()
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", (unit as { id: string }).id)
    .is("valid_to", null);
  const { error } = await db()
    .from("project_context_memberships")
    .insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual" });
  if (error) throw new Error(`curate failed: ${error.message}`);
}

function queryReq(token: string, question: string): NextRequest {
  return new Request("http://test/api/v1/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ question }),
  }) as unknown as NextRequest;
}

/** Drain the SSE body so the stream's `start` (and therefore `streamAnswer`) actually runs. */
async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("AUDITFIX-1 AC5: the real POST /api/v1/query attenuates a delegated token's structured context", () => {
  beforeEach(() => {
    captured.structured = [];
  });

  it("a NON-EMPTY-scoped aiosd_ token is served IN-scope hand-entered rows and never OUT-of-scope ones", async () => {
    const seed = await seedTeam();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    const { mintAgentToken } = await import("@/lib/access/agent-tokens");
    const { addMemberToGroup, createGroup, grantProjectToGroup } = await import("@/lib/access/groups");

    const inScope = await ingest(seed, { path: "r/in.md", body: `in ${TERM}`, access: "team", project: "rproj" });
    await ingest(seed, { path: "r/out.md", body: `out ${TERM}`, access: "team", project: "otherproj" });
    await backfillTeamContext(db(), seed.teamId);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
    await curateInto(seed, inScope.id, bySlug.get("rproj")!);

    // Hand-entered rows — no source item, so the ONLY thing that can gate them is the project the
    // author chose. Seeded in BOTH directions in one invocation, because a spec round found that
    // seeding only the in-scope half lets an implementation pass by deleting the gate outright, and
    // seeding only a TASK lets it gate the task leg while leaving the decision leg open.
    const inScopeTask = `INSCOPETASK-${randomUUID().slice(0, 8)}`;
    const inScopeDecision = `INSCOPEDECISION-${randomUUID().slice(0, 8)} ${TERM}`;
    const secretTask = `SECRETTASK-${randomUUID().slice(0, 8)}`;
    const secretDecision = `SECRETDECISION-${randomUUID().slice(0, 8)} ${TERM}`;
    const handEntered = async (title: string, decisionTitle: string, projectSlug: string) => {
      const t = await db().from("tasks").insert({
        team_id: seed.teamId, row_key: `RT-${randomUUID().slice(0, 6)}`, title, status: "in_progress",
        source_item_id: null, created_by: seed.memberId, audience: "team", project_id: bySlug.get(projectSlug)!, origin: "ui",
      });
      if (t.error) throw new Error(`task seed failed: ${t.error.message}`);
      const d = await db().from("decisions").insert({
        team_id: seed.teamId, row_key: `RD-${randomUUID().slice(0, 6)}`, title: decisionTitle, decided_by: "x",
        still_valid: true, source_item_id: null, created_by: seed.memberId, audience: "team", project_id: bySlug.get(projectSlug)!,
      });
      if (d.error) throw new Error(`decision seed failed: ${d.error.message}`);
    };
    await handEntered(inScopeTask, inScopeDecision, "rproj");
    await handEntered(secretTask, secretDecision, "otherproj");

    // A SOURCED task on the in-scope item — the survival half. Without it, a route that returned
    // an empty structured digest for every token would pass this test while breaking the feature.
    const sourcedTask = `SOURCEDTASK-${randomUUID().slice(0, 8)}`;
    const st = await db().from("tasks").insert({
      team_id: seed.teamId, row_key: `RS-${randomUUID().slice(0, 6)}`, title: sourcedTask, status: "in_progress",
      source_item_id: inScope.id, created_by: seed.memberId, audience: "team", project_id: bySlug.get("rproj")!, origin: "ui",
    });
    if (st.error) throw new Error(`sourced task seed failed: ${st.error.message}`);

    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, `rt-${randomUUID().slice(0, 6)}`, "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("rproj")!, g.groupId!, seed.memberId);
    const minted = await mintAgentToken(
      db(),
      seed.teamId,
      { memberId: agent, projectScope: [bySlug.get("rproj")!] },
      seed.memberId
    );
    expect(minted.ok, minted.error).toBe(true);
    expect(minted.token).toMatch(/^aiosd_/);

    const { POST: queryPOST } = await import("@/app/api/v1/query/route");
    const res = await queryPOST(queryReq(minted.token!, `tell me about ${TERM}`));
    expect(res.status, "the delegated query route admits the token").toBe(200);
    await drain(res);

    expect(captured.structured.length, "streamAnswer must have run — otherwise nothing was asserted").toBe(1);
    const structured = captured.structured[0];
    expect(structured, "the token's in-scope SOURCED task is still served").toContain(sourcedTask);
    // The RULING (AUDITFIX-7): an agent granted a project reads what a person typed into it.
    expect(structured, "an IN-SCOPE hand-entered TASK is served to the token").toContain(inScopeTask);
    expect(structured, "an IN-SCOPE hand-entered DECISION is served to the token").toContain(inScopeDecision);
    // AUDITFIX-1's protection, kept: the gate is a scope, not an open door.
    expect(structured, "an OUT-OF-SCOPE hand-entered TASK must never reach a token's prompt").not.toContain(secretTask);
    expect(structured, "an OUT-OF-SCOPE hand-entered DECISION must never reach a token's prompt").not.toContain(secretDecision);
  });

  it("an UNSCOPED token (projectScope: null) gets its launcher's projects — NOT nothing, NOT everything", async () => {
    // Spec round 2's BLOCKER. The oracle attenuates only when the scope is NON-NULL, so `null` means
    // "the launcher's granted projects" while `[]` means "sees nothing". Every other criterion here
    // uses an explicit non-empty scope, so an implementation returning `[]` for a null scope would
    // pass all of them and silently blind every unscoped agent — which is the exact narrowing the
    // ruling forbids, and it would look identical to today's behaviour.
    const seed = await seedTeam();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    const { mintAgentToken } = await import("@/lib/access/agent-tokens");
    const { addMemberToGroup, createGroup, grantProjectToGroup } = await import("@/lib/access/groups");

    await ingest(seed, { path: "u/in.md", body: `in ${TERM}`, access: "team", project: "uproj" });
    await ingest(seed, { path: "u/out.md", body: `out ${TERM}`, access: "team", project: "uother" });
    await backfillTeamContext(db(), seed.teamId);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));

    const reachable = `UNSCOPEDREACHABLE-${randomUUID().slice(0, 8)}`;
    const unreachable = `UNSCOPEDUNREACHABLE-${randomUUID().slice(0, 8)}`;
    for (const [title, slug] of [[reachable, "uproj"], [unreachable, "uother"]] as const) {
      const r = await db().from("tasks").insert({
        team_id: seed.teamId, row_key: `UT-${randomUUID().slice(0, 6)}`, title, status: "in_progress",
        source_item_id: null, created_by: seed.memberId, audience: "team", project_id: bySlug.get(slug)!, origin: "ui",
      });
      if (r.error) throw new Error(`task seed failed: ${r.error.message}`);
    }

    // The agent is granted ONLY uproj. The token names NO scope at all.
    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, `ut-${randomUUID().slice(0, 6)}`, "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("uproj")!, g.groupId!, seed.memberId);
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent, projectScope: null }, seed.memberId);
    expect(minted.ok, minted.error).toBe(true);

    const { POST: queryPOST } = await import("@/app/api/v1/query/route");
    const res = await queryPOST(queryReq(minted.token!, `tell me about ${TERM}`));
    expect(res.status).toBe(200);
    await drain(res);

    expect(captured.structured.length, "streamAnswer must have run").toBe(1);
    const structured = captured.structured[0];
    expect(structured, "an unscoped token still reaches its launcher's granted project").toContain(reachable);
    expect(structured, "an unscoped token is NOT unattenuated — an ungranted project stays closed").not.toContain(unreachable);
  });
});
