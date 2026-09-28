import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { parseSubmitRequest } from "./contract";

/** Call only after authenticating a current human team administrator. */
export async function loadGovernedApprovalProposals(teamId: string, approvalIds: string[]) {
  const values = new Map<string, Record<string, string | null>>();
  if (!approvalIds.length) return values;
  const proposals = await runSql<{ approval_request_id: string; request: string }>(
    `select a.approval_request_id, a.request from governed_actions a
     join governed_action_identities i on i.id=a.identity_id
     where i.team_id=$1 and a.approval_request_id=any($2::uuid[])`,
    [teamId, approvalIds],
  );
  for (const proposal of proposals.rows) {
    const request = parseSubmitRequest(JSON.parse(proposal.request));
    const params = request.type === "task.update" ? request.params.changes : request.params;
    values.set(proposal.approval_request_id, Object.fromEntries(Object.entries(params).filter(([key]) =>
      ["title", "body", "rationale", "impact", "assignee", "status", "due"].includes(key),
    )) as Record<string, string | null>);
  }
  return values;
}
