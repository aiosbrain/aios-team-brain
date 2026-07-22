import { adminFailure, gatewayAdminContext } from "@/lib/gateway/admin-http";
import { decideGatewayApproval } from "@/lib/gateway/admin-persistence";
import {
  exactObject,
  gatewayDisabled,
  gatewayError,
  gatewayJson,
  isResponse,
  isUuid,
  readGatewayJson,
} from "@/lib/gateway/http";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ teamSlug: string; approvalId: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const path = await params;
  const ctx = await gatewayAdminContext(path.teamSlug);
  if (isResponse(ctx)) return ctx;
  if (!isUuid(path.approvalId)) return gatewayError("gateway_not_found", 404);
  const body = await readGatewayJson(req);
  if (isResponse(body)) return body;
  if (
    !exactObject(body, ["decision", "correlationId"]) ||
    !["approve", "deny"].includes(String(body.decision)) ||
    !isUuid(body.correlationId)
  )
    return gatewayError("gateway_invalid_request", 400);
  try {
    return gatewayJson(
      await decideGatewayApproval(
        ctx,
        path.approvalId,
        body.decision as "approve" | "deny",
        body.correlationId,
      ),
    );
  } catch (error) {
    return adminFailure(error, body.correlationId);
  }
}
