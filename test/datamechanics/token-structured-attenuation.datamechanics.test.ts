import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * Spec (AUDITFIX-1, real Postgres): a delegated token's STRUCTURED context obeys its scope.
 *
 * The reproduced defect: `provenanceRowSqlFromIds` admitted `source_item_id is null and created_by is
 * not null and <teamPosture>` with no reference to `visibleItemIds`, and every valid token is
 * team-tier — so a token received every hand-typed task and decision in the team, including rows in
 * projects it was never granted.
 *
 * WHY THE NON-EMPTY-SCOPE ARM IS THE ONE THAT MATTERS (spec review round 1): an implementation
 * reading `principal === "token" && visibleItemIds.size === 0` closes only the empty case and leaks
 * for every realistically-scoped token — and non-empty scope is the NORMAL delegated shape.
 */

const TERM = "zanzibarite"; // rare shared term so the keyword leg matches the fixtures

async function projectsBySlug(seed: Seed): Promise<Map<string, string>> {
  const { data } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
  return new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
}

async function curateInto(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships")
    .insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual" });
  if (error) throw new Error(`curate failed: ${error.message}`);
}

/** A hand-entered (unsourced) task + decision: source_item_id NULL, created_by set. */
async function seedHandEntered(seed: Seed, projectId: string): Promise<{ task: string; decision: string }> {
  const task = `SECRETTASK-${randomUUID().slice(0, 8)}`;
  const decision = `SECRETDECISION-${randomUUID().slice(0, 8)} ${TERM}`;
  const t = await db().from("tasks").insert({
    team_id: seed.teamId, row_key: `AUD-${randomUUID().slice(0, 6)}`, title: task, status: "in_progress",
    source_item_id: null, created_by: seed.memberId, audience: "team", project_id: projectId, origin: "ui",
  });
  if (t.error) throw new Error(`task seed failed: ${t.error.message}`);
  const d = await db().from("decisions").insert({
    team_id: seed.teamId, row_key: `AUDD-${randomUUID().slice(0, 6)}`, title: decision, decided_by: "someone",
    still_valid: true, source_item_id: null, created_by: seed.memberId, audience: "team", project_id: projectId,
  });
  if (d.error) throw new Error(`decision seed failed: ${d.error.message}`);
  return { task, decision };
}

const retrieveAs = async (seed: Seed, ids: Set<string>, principal: "member" | "token") => {
  const { retrieve } = await import("@/lib/query/retrieve");
  return retrieve(db(), seed.teamId, "team", `tell me about ${TERM}`, null, {
    visibleItemIds: ids,
    principal,
  } as Parameters<typeof retrieve>[5]);
};

describe("AUDITFIX-1: a delegated token's structured context obeys its scope (real Postgres)", () => {
  it("EMPTY scope receives no hand-entered rows — while a member control receives both", async () => {
    const seed = await seedTeam();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await ingest(seed, { path: "x/doc.md", body: `x ${TERM}`, access: "team", project: "xproj" });
    await backfillTeamContext(db(), seed.teamId);
    const secrets = await seedHandEntered(seed, (await projectsBySlug(seed)).get("xproj")!);

    // CONTROL FIRST. Without it a green test proves only that the fixture is inert — which is how
    // the original audit repro passed before its inserts were found to be failing silently.
    const control = await retrieveAs(seed, new Set(), "member");
    expect(control.structured, "CONTROL: a member at team posture DOES see hand-entered rows").toContain(secrets.task);
    expect(control.structured, "CONTROL: …and the hand-entered decision").toContain(secrets.decision);

    const token = await retrieveAs(seed, new Set(), "token");
    expect(token.structured ?? "", "a zero-scope token must not receive a hand-entered TASK").not.toContain(secrets.task);
    expect(token.structured ?? "", "a zero-scope token must not receive a hand-entered DECISION").not.toContain(secrets.decision);
  });

  it("NON-EMPTY scope receives its sourced rows AND no hand-entered rows — the case that matters", async () => {
    // The arm review round 1 said the suite otherwise misses entirely: an implementation that only
    // closes for size===0 passes every other assertion here and still leaks for every real token.
    const seed = await seedTeam();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    const inScope = await ingest(seed, { path: "a/in-scope.md", body: `in ${TERM}`, access: "team", project: "agentproj" });
    await backfillTeamContext(db(), seed.teamId);
    const bySlug = await projectsBySlug(seed);
    await curateInto(seed, inScope.id, bySlug.get("agentproj")!);

    // A SOURCED task tied to the in-scope item — this must SURVIVE the fix.
    const sourcedTitle = `SOURCEDTASK-${randomUUID().slice(0, 8)}`;
    const st = await db().from("tasks").insert({
      team_id: seed.teamId, row_key: `SRC-${randomUUID().slice(0, 6)}`, title: sourcedTitle, status: "in_progress",
      source_item_id: inScope.id, created_by: seed.memberId, audience: "team",
      project_id: bySlug.get("agentproj")!, origin: "ui",
    });
    if (st.error) throw new Error(`sourced task seed failed: ${st.error.message}`);
    const secrets = await seedHandEntered(seed, bySlug.get("agentproj")!);

    const token = await retrieveAs(seed, new Set([inScope.id]), "token");
    expect(token.structured ?? "", "its in-scope SOURCED task must still be served").toContain(sourcedTitle);
    expect(token.structured ?? "", "but NOT a hand-entered task").not.toContain(secrets.task);
    expect(token.structured ?? "", "and NOT a hand-entered decision").not.toContain(secrets.decision);
  });

  it("a MEMBER is unchanged — the settled ENFB-2 hand-typed rule survives this slice", async () => {
    const seed = await seedTeam();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await ingest(seed, { path: "m/doc.md", body: `m ${TERM}`, access: "team", project: "mproj" });
    await backfillTeamContext(db(), seed.teamId);
    const secrets = await seedHandEntered(seed, (await projectsBySlug(seed)).get("mproj")!);

    const member = await retrieveAs(seed, new Set(), "member");
    expect(member.structured, "members still see hand-entered tasks at team posture").toContain(secrets.task);
    expect(member.structured, "and hand-entered decisions").toContain(secrets.decision);
  });

  it("the keyword-decision leg obeys the rule too — both halves, one invocation", async () => {
    // matchingDecisions is the SECOND token-reachable leg; a fix applied only to retrieve's windows
    // would miss it. Both halves asserted together so an inert keyword fixture cannot pass this.
    const seed = await seedTeam();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    const inScope = await ingest(seed, { path: "k/in.md", body: `k ${TERM}`, access: "team", project: "kproj" });
    await backfillTeamContext(db(), seed.teamId);
    const bySlug = await projectsBySlug(seed);
    await curateInto(seed, inScope.id, bySlug.get("kproj")!);

    const sourcedDecision = `SOURCEDDECISION-${randomUUID().slice(0, 8)} ${TERM}`;
    const sd = await db().from("decisions").insert({
      team_id: seed.teamId, row_key: `KSRC-${randomUUID().slice(0, 6)}`, title: sourcedDecision, decided_by: "x",
      still_valid: true, source_item_id: inScope.id, created_by: seed.memberId, audience: "team",
      project_id: bySlug.get("kproj")!,
    });
    if (sd.error) throw new Error(`sourced decision seed failed: ${sd.error.message}`);
    const secrets = await seedHandEntered(seed, bySlug.get("kproj")!);

    const { matchingDecisions } = await import("@/lib/query/structured-extras");
    const titles = (await matchingDecisions(seed.teamId, "team", TERM, 10, {
      visibleItemIds: new Set([inScope.id]),
      teamPosture: true,
      principal: "token",
    })).map((d) => d.title);

    expect(titles.join("\n"), "the in-scope SOURCED decision is served").toContain(sourcedDecision);
    expect(titles.join("\n"), "the hand-entered one is not").not.toContain(secrets.decision);
  });
});
