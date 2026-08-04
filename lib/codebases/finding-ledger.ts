import { z } from "zod";
import type { CodebaseHealth } from "@/lib/api/schemas";
import type { DbClient } from "@/lib/db/types";

export type FindingStatus =
  | "open"
  | "accepted"
  | "resolved"
  | "reopened"
  | "false_positive"
  | "risk_accepted"
  | "superseded"
  | "stale_analysis";

export type FindingEventType =
  | "detected"
  | "observed"
  | "resolved"
  | "reopened"
  | "stale_analysis"
  | "accepted"
  | "risk_accepted"
  | "false_positive"
  | "expired"
  | "superseded";

export const findingDecisionSchema = z.object({
  findingId: z.string().uuid(),
  ownerMemberId: z.string().uuid(),
  status: z.enum(["accepted", "risk_accepted", "false_positive"]),
  reason: z.string().trim().min(10).max(500),
  expiresAt: z.string().datetime({ offset: true }),
});

export type FindingDecision = z.infer<typeof findingDecisionSchema>;

export type FindingTransition = {
  status: FindingStatus;
  event: FindingEventType;
  mutatesCurrent: boolean;
};

type EvidenceStatus = "complete" | "partial" | "missing" | "stale" | "error";

const RESOLVABLE_STATUSES = new Set<FindingStatus>([
  "open",
  "reopened",
  "accepted",
  "risk_accepted",
  "false_positive",
]);
const DECISION_STATUSES = new Set<FindingStatus>([
  "accepted",
  "risk_accepted",
  "false_positive",
]);

/**
 * Pure mirror of the database lifecycle rules. The SQL function is the atomic writer;
 * this helper keeps the fail-closed transition contract executable in fast unit tests.
 */
export function decideFindingTransition(input: {
  currentStatus: FindingStatus | null;
  present: boolean;
  evidenceStatus: EvidenceStatus;
  olderThanCurrent?: boolean;
  decisionNewerThanEvidence?: boolean;
}): FindingTransition | null {
  const {
    currentStatus,
    present,
    evidenceStatus,
    olderThanCurrent = false,
    decisionNewerThanEvidence = false,
  } = input;

  if (olderThanCurrent) {
    if (currentStatus) {
      return { status: currentStatus, event: "stale_analysis", mutatesCurrent: false };
    }
    return present
      ? { status: "stale_analysis", event: "stale_analysis", mutatesCurrent: false }
      : null;
  }

  if (present) {
    if (!currentStatus) return { status: "open", event: "detected", mutatesCurrent: true };
    if (currentStatus === "resolved" || currentStatus === "stale_analysis") {
      return { status: "reopened", event: "reopened", mutatesCurrent: true };
    }
    return { status: currentStatus, event: "observed", mutatesCurrent: true };
  }

  if (
    evidenceStatus === "complete" &&
    currentStatus != null &&
    RESOLVABLE_STATUSES.has(currentStatus) &&
    !(DECISION_STATUSES.has(currentStatus) && decisionNewerThanEvidence)
  ) {
    return { status: "resolved", event: "resolved", mutatesCurrent: true };
  }
  return null;
}

export interface FindingReconcileResult {
  detected: number;
  observed: number;
  resolved: number;
  reopened: number;
  stale: number;
}

const EMPTY_RESULT: FindingReconcileResult = {
  detected: 0,
  observed: 0,
  resolved: 0,
  reopened: 0,
  stale: 0,
};

/** Atomically project one validated v2 snapshot into current state + append-only history. */
export async function reconcileCodebaseFindings(
  db: DbClient,
  input: {
    teamId: string;
    codebaseId: string;
    metricsId: string;
    health: CodebaseHealth | undefined;
  }
): Promise<FindingReconcileResult> {
  if (!input.health || input.health.schema_version !== "2") return EMPTY_RESULT;

  const { data, error } = await db.rpc("reconcile_codebase_findings", {
    p_team_id: input.teamId,
    p_codebase_id: input.codebaseId,
    p_metrics_id: input.metricsId,
    p_health: input.health,
  });
  if (error) throw new Error(`finding reconciliation failed: ${error.message}`);
  return { ...EMPTY_RESULT, ...(data as Partial<FindingReconcileResult>) };
}

/** Record an operator decision atomically with its append-only finding event. */
export async function decideCodebaseFinding(
  db: DbClient,
  input: FindingDecision & {
    teamId: string;
    codebaseId: string;
    actorMemberId: string;
  }
): Promise<{ findingId: string; status: FindingDecision["status"] }> {
  const decision = findingDecisionSchema.parse(input);
  const { data, error } = await db.rpc("decide_codebase_finding", {
    p_team_id: input.teamId,
    p_codebase_id: input.codebaseId,
    p_finding_id: decision.findingId,
    p_actor_member_id: input.actorMemberId,
    p_owner_member_id: decision.ownerMemberId,
    p_decision_status: decision.status,
    p_reason: decision.reason,
    p_expires_at: decision.expiresAt,
  });
  if (error) throw new Error(`finding decision failed: ${error.message}`);
  return {
    findingId: (data as { finding_id: string }).finding_id,
    status: (data as { status: FindingDecision["status"] }).status,
  };
}
