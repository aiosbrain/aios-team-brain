import type { ActionError } from "./contract";
const messages: Record<ActionError["code"], string> = {
  invalid_payload: "Invalid action request.",
  unauthorized: "Valid member credentials required.",
  not_found: "Action or destination not found.",
  forbidden: "Action is not permitted.",
  revoked_authorization: "Authorization changed; request a new action.",
  stale_revision: "The entity changed.",
  operation_id_conflict: "Operation ID is already bound to different input.",
  mapping_required: "Provider mapping required.",
  upgrade_required: "Client upgrade required.",
  capability_unavailable: "This action capability is unavailable.",
  rate_limited: "Request limit reached.",
  execution_failed: "Action execution failed.",
  operation_in_progress: "Action is processing.",
  unavailable: "Action service temporarily unavailable.",
};
export function actionError(code: ActionError["code"]): ActionError {
  return {
    code,
    message: messages[code],
    retryable: [
      "unavailable",
      "rate_limited",
      "operation_in_progress",
    ].includes(code),
    recovery:
      code === "unavailable"
        ? "Retry the same operation or check its status."
        : "Refresh authorization and current state before requesting a new operation.",
  };
}
export class GovernedError extends Error {
  readonly detail: ActionError;
  constructor(
    readonly code: ActionError["code"],
    readonly status: number,
  ) {
    super(messages[code]);
    this.detail = actionError(code);
  }
}
/** Consumers may settle only these explicit safe business failures. All other throws roll back execution. */
export class DomainFailure extends Error {
  constructor(
    readonly code:
      | "stale_revision"
      | "mapping_required"
      | "execution_failed"
      | "forbidden",
    readonly status: "conflict" | "failed" | "denied" = "failed",
  ) {
    super(messages[code]);
  }
}
