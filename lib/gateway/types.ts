import "server-only";

export const GATEWAY_TOOLKIT = "aios-github-readonly" as const;
export const GATEWAY_LEASE_TTL_SECONDS = 30 as const;
export const GATEWAY_APPROVAL_TTL_MINUTES = 15 as const;
export const GATEWAY_ENVELOPE_MAX_BYTES = 64 * 1024;

export type GatewayDecision = "block" | "require_approval" | "allow";
export type GatewayExecutionState =
  | "blocked"
  | "approval_required"
  | "approved"
  | "claimed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";
export type GatewayApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type GatewayOutcomeClassification =
  | "success"
  | "blocked"
  | "approval_required"
  | "credential"
  | "network"
  | "upstream"
  | "response_too_large"
  | "internal";

export interface GatewayServiceIdentity {
  id: string;
  teamId: string;
  environment: string;
  credentialId: string;
  credentialVersion: number;
  activatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ExecutorSubjectBinding {
  id: string;
  teamId: string;
  memberId: string;
  serviceIdentityId: string;
  executorTenantId: string;
  executorSubjectId: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface GatewayConnectionRef {
  id: string;
  connectionRef: string;
  teamId: string;
  memberId: string;
  serviceIdentityId: string;
  subjectBindingId: string;
  provider: "github";
  enabled: boolean;
  revokedAt: string | null;
}

export interface ResolutionLease {
  id: string;
  audience: string;
  teamId: string;
  memberId: string;
  serviceIdentityId: string;
  subjectBindingId: string;
  connectionId: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}

export interface GatewayExecution {
  id: string;
  teamId: string;
  memberId: string;
  subjectBindingId: string;
  connectionId: string;
  correlationId: string;
  idempotencyKey: string;
  toolkit: string;
  tool: string;
  requestHash: string;
  decision: GatewayDecision;
  state: GatewayExecutionState;
}

export interface GatewayApproval {
  id: string;
  teamId: string;
  executionId: string;
  status: GatewayApprovalStatus;
  expiresAt: string;
  approverMemberId: string | null;
}

export interface GatewayPolicyRule {
  id: string;
  version: string;
  decision: GatewayDecision;
}

export type AuthorizeDecision =
  | { decision: "block"; executionId: string }
  | { decision: "require_approval"; executionId: string; approvalId: string; expiresAt: string }
  | { decision: "allow"; executionId: string };

export interface ExecutionOutcome {
  executionId: string;
  classification: GatewayOutcomeClassification;
  upstreamStatusClass?: "2xx" | "3xx" | "4xx" | "5xx";
  responseBytes?: number;
}

export type GatewayPersistenceErrorCode =
  | "gateway_scope_not_found"
  | "gateway_lease_invalid"
  | "gateway_execution_not_claimable"
  | "gateway_approval_not_pending"
  | "gateway_not_found"
  | "gateway_approval_expired"
  | "gateway_idempotency_conflict";

export class GatewayPersistenceError extends Error {
  constructor(readonly code: GatewayPersistenceErrorCode) {
    super(code);
    this.name = "GatewayPersistenceError";
  }
}
