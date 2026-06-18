import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scopeQueryLog } from "@/lib/auth/visibility";
import { db, seedTeam } from "./helpers";

// query_log row-level scoping (lib/auth/visibility.scopeQueryLog), verified to the observable
// outcome on real Postgres (DB_BACKEND=postgres → no RLS). This is the SOLE enforcement that a
// non-admin member cannot read another member's questions / cost_usd. Reproduces the bug the
// page-level comment falsely claimed RLS handled.

async function addMember(teamId: string, role: "admin" | "lead" | "member") {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${role}`,
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role,
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

async function logQuery(teamId: string, memberId: string, question: string) {
  const { error } = await db()
    .from("query_log")
    .insert({ team_id: teamId, member_id: memberId, question, answer_preview: "", cost_usd: 1.5 });
  if (error) throw new Error(`seed query_log failed: ${error.message}`);
}

describe("scopeQueryLog() on real Postgres", () => {
  it("a member sees only their own query_log rows; an admin sees the whole team's", async () => {
    const seed = await seedTeam(); // memberId is a 'member'
    const other = await addMember(seed.teamId, "member");
    await logQuery(seed.teamId, seed.memberId, "my own question");
    await logQuery(seed.teamId, other, "someone else's question");

    const base = () =>
      db().from("query_log").select("question, member_id").eq("team_id", seed.teamId);

    // Non-admin member: only their own row, no leak of the other member's question/cost.
    const { data: mine } = await scopeQueryLog(base(), {
      isAdmin: false,
      memberId: seed.memberId,
    });
    const myQuestions = (mine ?? []).map((r: { question: string }) => r.question);
    expect(myQuestions).toContain("my own question");
    expect(myQuestions).not.toContain("someone else's question"); // no leak, no RLS backstop

    // Admin: team-wide visibility (non-vacuity — both rows are present in the table).
    const { data: all } = await scopeQueryLog(base(), { isAdmin: true, memberId: seed.memberId });
    const allQuestions = (all ?? []).map((r: { question: string }) => r.question);
    expect(allQuestions).toContain("my own question");
    expect(allQuestions).toContain("someone else's question");
  });
});
