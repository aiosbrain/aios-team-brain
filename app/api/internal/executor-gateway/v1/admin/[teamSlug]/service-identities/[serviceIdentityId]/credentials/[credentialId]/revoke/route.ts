import { adminFailure, gatewayAdminContext } from "@/lib/gateway/admin-http";
import { revokeGatewayCredential } from "@/lib/gateway/admin-persistence";
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
  {
    params,
  }: {
    params: Promise<{
      teamSlug: string;
      serviceIdentityId: string;
      credentialId: string;
    }>;
  },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const path = await params;
  const ctx = await gatewayAdminContext(path.teamSlug);
  if (isResponse(ctx)) return ctx;
  if (
    !isUuid(path.serviceIdentityId) ||
    !/^[A-Za-z0-9_-]{22}$/.test(path.credentialId)
  )
    return gatewayError("gateway_not_found", 404);
  const body = await readGatewayJson(req);
  if (
    isResponse(body) ||
    !exactObject(body, ["correlationId"]) ||
    !isUuid(body.correlationId)
  )
    return isResponse(body)
      ? body
      : gatewayError("gateway_invalid_request", 400);
  try {
    await revokeGatewayCredential(
      ctx,
      path.serviceIdentityId,
      path.credentialId,
      body.correlationId,
    );
    return gatewayJson({
      credentialId: path.credentialId,
      revoked: true,
    });
  } catch (error) {
    return adminFailure(error, body.correlationId);
  }
}
