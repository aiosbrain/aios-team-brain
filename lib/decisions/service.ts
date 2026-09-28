import "server-only";
import { randomUUID } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { isPrincipal } from "@/lib/access/eligibility";
import { uiRowKey, isUniqueViolation } from "@/lib/ids";
import { DomainFailure } from "@/lib/actions/governed/errors";
import { parseSubmitRequest, type ConsumerResult, type SubmitRequest } from "@/lib/actions/governed/contract";
import type { GovernedContext } from "@/lib/actions/governed";

export interface DecisionContent { title: string; rationale: string; impact: string }
export interface CreatedDecision { id: string; row_key: string; title: string }

/** Content stays exact in storage and in its canonical source; headings supply context only. */
export function renderDecisionBody(content: DecisionContent): string {
  return `# ${content.title}\n\n## Rationale\n\n${content.rationale}\n\n## Impact\n\n${content.impact}`;
}

/** Domain role comes from the member row, never the policy principal's synthetic role. */
export async function requireDecisionActor(db: DbClient, teamId: string, memberId: string): Promise<{ actor_handle: string }> {
  const { data, error } = await db.from("members").select("role,kind,is_connector,status,actor_handle")
    .eq("team_id", teamId).eq("id", memberId).maybeSingle();
  if (error) throw new Error("Decision authority unavailable");
  const member = data as { role: string; kind: string; is_connector: boolean; status: string; actor_handle: string } | null;
  if (!member || !isPrincipal(member) || !["admin", "lead"].includes(member.role))
    throw new DomainFailure("forbidden", "denied");
  return { actor_handle: member.actor_handle };
}

/** Dashboard adapter keeps its established metadata; external actions never accept these fields. */
export async function createDashboardDecision(db: DbClient, input: {
  teamId: string; memberId: string; projectId: string; title: string; rationale: string;
  impact: string; decidedBy: string; decidedAt: string | null; audience: "team" | "external";
}): Promise<CreatedDecision> {
  await requireDecisionActor(db, input.teamId, input.memberId);
  const { canSeeProjectRow } = await import("@/lib/access/enforce");
  if (!(await canSeeProjectRow(db, { teamId: input.teamId, memberId: input.memberId }, input.projectId)))
    throw new Error("project not found");
  const title = input.title.trim();
  if (!title) throw new Error("title and project required");
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.from("decisions").insert({
      team_id: input.teamId, project_id: input.projectId, source_item_id: null,
      created_by: input.memberId, row_key: uiRowKey(), title,
      rationale: input.rationale.trim(), impact: input.impact.trim(), decided_by: input.decidedBy.trim(),
      decided_at: input.decidedAt || null, audience: input.audience === "external" ? "external" : "team",
    }).select("id,row_key,title").single();
    if (!error && data) return data as CreatedDecision;
    if (attempt === 0 && isUniqueViolation(error?.message)) continue;
    throw new Error(error?.message ?? "could not create decision");
  }
  throw new Error("could not create decision");
}

export async function recordGovernedDecision(ctx: GovernedContext, raw: SubmitRequest): Promise<ConsumerResult> {
  const request = parseSubmitRequest(raw);
  if (request.type !== "decision.record" || request.destination.project_id !== ctx.projectId)
    throw new DomainFailure("forbidden", "denied");
  const actor = await requireDecisionActor(ctx.db, ctx.teamId, ctx.memberId);
  // The foundation has already checked current project membership under its authority lock.
  // appendGovernedItem checks the destination's content placement without authority writes.
  const { appendGovernedItem } = await import("@/lib/ingest/governed-item");
  const id = randomUUID();
  const { itemId, revision } = await appendGovernedItem(ctx, {
    kind: "decision", title: request.params.title, body: renderDecisionBody(request.params),
    entityId: id, identityKey: request.params.operation_id,
  });
  await ctx.query(
    `insert into decisions(id,team_id,project_id,source_item_id,created_by,row_key,decided_at,title,rationale,decided_by,impact,audience)
     values($1,$2,$3,$4,$5,$6,(now() at time zone 'UTC')::date,$7,$8,$9,$10,'team')`,
    [id, ctx.teamId, ctx.projectId, itemId, ctx.memberId, uiRowKey(), request.params.title,
      request.params.rationale, actor.actor_handle, request.params.impact],
  );
  return { entity: { kind: "decision", id, revision }, sync: { state: "not_applicable", providers: [] } };
}
