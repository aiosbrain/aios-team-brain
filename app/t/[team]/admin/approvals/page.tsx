import { serverClient } from "@/lib/db/server";
import { ApprovalsQueue, type ApprovalRow, type DecidedRow } from "@/components/admin/approvals-queue";
import {
  ManagedGatewayApprovals,
  type ManagedGatewayApprovalRow,
} from "@/components/admin/managed-gateway-approvals";
import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeGatewayAdmin,
  listGatewayApprovals,
} from "@/lib/gateway/admin-persistence";

export default async function ApprovalsAdminPage({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  const db = await serverClient();

  const { data: team } = await db.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;

  const { data: pending } = await db
    .from("approval_requests")
    .select("id, requested_by_actor, action, resource, context, created_at")
    .eq("team_id", team.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  const { data: recent } = await db
    .from("approval_requests")
    .select("id, requested_by_actor, action, resource, status, decided_at, decision_note")
    .eq("team_id", team.id)
    .in("status", ["approved", "denied", "expired"])
    .order("decided_at", { ascending: false })
    .limit(10);

  let managed: ManagedGatewayApprovalRow[] | null = null;
  if (process.env.AIOS_GATEWAY_INTERNAL_ENABLED === "true") {
    const user = await getSessionUser();
    if (user) {
      try {
        const ctx = await authorizeGatewayAdmin(teamSlug, user.id);
        managed = (await listGatewayApprovals(ctx)) as ManagedGatewayApprovalRow[];
      } catch {
        managed = null;
      }
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
        pending={(pending ?? []) as ApprovalRow[]}
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
