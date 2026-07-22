import { adminFailure, gatewayAdminContext } from "@/lib/gateway/admin-http";
import {
  deleteGatewayAdminPolicy,
  updateGatewayAdminPolicy,
} from "@/lib/gateway/admin-persistence";
import { parseGatewayPolicyInput } from "@/lib/gateway/admin-validation";
import {
  gatewayDisabled,
  gatewayError,
  gatewayJson,
  isResponse,
  isUuid,
  readGatewayJson,
} from "@/lib/gateway/http";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ teamSlug: string; policyId: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const path = await params;
  const ctx = await gatewayAdminContext(path.teamSlug);
  if (isResponse(ctx)) return ctx;
  if (!isUuid(path.policyId)) return gatewayError("gateway_not_found", 404);
  const body = await readGatewayJson(req);
  if (isResponse(body)) return body;
  const input = parseGatewayPolicyInput(body);
  if (!input) return gatewayError("gateway_invalid_request", 400);
  try {
    return gatewayJson(await updateGatewayAdminPolicy(ctx, path.policyId, input));
  } catch (error) {
    return adminFailure(error, input.correlationId);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ teamSlug: string; policyId: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const path = await params;
  const ctx = await gatewayAdminContext(path.teamSlug);
  if (isResponse(ctx)) return ctx;
  if (!isUuid(path.policyId)) return gatewayError("gateway_not_found", 404);
  const body = await readGatewayJson(req);
  if (
    isResponse(body) ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "correlationId") ||
    !isUuid((body as Record<string, unknown>).correlationId)
  )
    return isResponse(body)
      ? body
      : gatewayError("gateway_invalid_request", 400);
  const correlationId = (body as { correlationId: string }).correlationId;
  try {
    await deleteGatewayAdminPolicy(ctx, path.policyId, correlationId);
    return gatewayJson({ deleted: true });
  } catch (error) {
    return adminFailure(error, correlationId);
  }
}
