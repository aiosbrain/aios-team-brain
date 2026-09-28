import { serverClient } from "@/lib/db/server";
import { ApprovalsQueue, type ApprovalRow, type DecidedRow } from "@/components/admin/approvals-queue";
import {
  ManagedGatewayApprovals,
  type ManagedGatewayApprovalRow,
} from "@/components/admin/managed-gateway-approvals";
import { getSessionUser } from "@/lib/auth/session";
import { requireTeamAdmin } from "@/lib/auth/guard";
import { runSql } from "@/lib/db/pg/pool";
import { parseSubmitRequest } from "@/lib/actions/governed/contract";
import {
  authorizeGatewayAdmin,
  listGatewayApprovals,
} from "@/lib/gateway/admin-persistence";

export default async function ApprovalsAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  // A layout can render concurrently: authorize before reading proposed content.
  const admin = await requireTeamAdmin(teamSlug);
  if (!admin) return null;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  // The pending queue, the recently-decided list, and the (optional) managed-gateway approvals are
  // independent reads — load them concurrently instead of in series. `managed` keeps its own
  // env-gated auth sub-chain inside a self-contained async so it can't slow the two queue reads.
  const [pendingRes, recentRes, managed] = await Promise.all([
    db
      .from("approval_requests")
      .select("id, requested_by_actor, action, resource, context, created_at")
      .eq("team_id", team.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    db
      .from("approval_requests")
      .select("id, requested_by_actor, action, resource, status, decided_at, decision_note")
      .eq("team_id", team.id)
      .in("status", ["approved", "denied", "expired"])
      .order("decided_at", { ascending: false })
      .limit(10),
    (async (): Promise<ManagedGatewayApprovalRow[] | null> => {
      if (process.env.AIOS_GATEWAY_INTERNAL_ENABLED !== "true") return null;
      const user = await getSessionUser();
      if (!user) return null;
      try {
        const ctx = await authorizeGatewayAdmin(teamSlug, user.id);
        return (await listGatewayApprovals(ctx)) as ManagedGatewayApprovalRow[];
      } catch {
        return null;
      }
    })(),
  ]);
  const pending = (pendingRes.data ?? []) as ApprovalRow[];
  const recent = recentRes.data;
  const governedIds = pending.filter(row => row.context?.governed_action_id).map(row => row.id);
  if (governedIds.length) {
    const proposals = await runSql<{ approval_request_id: string; request: string }>(
      `select a.approval_request_id, a.request from governed_actions a
       join governed_action_identities i on i.id=a.identity_id
       where i.team_id=$1 and a.approval_request_id=any($2::uuid[])`,
      [admin.teamId, governedIds],
    );
    for (const row of pending) {
      const proposal = proposals.rows.find(value => value.approval_request_id === row.id);
      if (!proposal) continue;
      const request = parseSubmitRequest(JSON.parse(proposal.request));
      const values = request.type === "task.update" ? request.params.changes : request.params;
      row.proposed = Object.fromEntries(Object.entries(values).filter(([key]) =>
        ["title", "body", "rationale", "impact", "assignee", "status", "due"].includes(key),
      )) as Record<string, string | null>;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Agent actions that matched a <code>require_approval</code> policy and are waiting on a human.
        Approving resumes and runs the action; denying stops it. Both are audited.
      </p>
      <ApprovalsQueue
        teamSlug={teamSlug}
        pending={pending}
        recent={(recent ?? []) as DecidedRow[]}
      />
      {managed ? (
        <div className="mt-3 border-t border-border-subtle pt-6">
          <ManagedGatewayApprovals teamSlug={teamSlug} approvals={managed} />
        </div>
      ) : null}
    </div>
  );
}
