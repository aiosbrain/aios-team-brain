import { adminFailure, gatewayAdminContext } from "@/lib/gateway/admin-http";
import {
  listGatewayCredentials,
  rotateGatewayCredential,
} from "@/lib/gateway/admin-persistence";
import {
  exactObject,
  gatewayDisabled,
  gatewayError,
  gatewayJson,
  isResponse,
  isUuid,
  readGatewayJson,
} from "@/lib/gateway/http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ teamSlug: string; serviceIdentityId: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const path = await params;
  const ctx = await gatewayAdminContext(path.teamSlug);
  if (isResponse(ctx)) return ctx;
  if (!isUuid(path.serviceIdentityId))
    return gatewayError("gateway_not_found", 404);
  try {
    return gatewayJson({
      credentials: await listGatewayCredentials(ctx, path.serviceIdentityId),
    });
  } catch (error) {
    return adminFailure(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ teamSlug: string; serviceIdentityId: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const path = await params;
  const ctx = await gatewayAdminContext(path.teamSlug);
  if (isResponse(ctx)) return ctx;
  if (!isUuid(path.serviceIdentityId))
    return gatewayError("gateway_not_found", 404);
  const body = await readGatewayJson(req);
  if (isResponse(body)) return body;
  if (
    !exactObject(
      body,
      ["credentialId", "secret", "replacesCredentialId", "correlationId"],
      ["expiresAt"],
    ) ||
    typeof body.credentialId !== "string" ||
    typeof body.secret !== "string" ||
    typeof body.replacesCredentialId !== "string" ||
    !isUuid(body.correlationId) ||
    (body.expiresAt !== undefined &&
      (typeof body.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(body.expiresAt))))
  )
    return gatewayError("gateway_invalid_request", 400);
  try {
    return gatewayJson(
      await rotateGatewayCredential(ctx, path.serviceIdentityId, {
        credentialId: body.credentialId,
        secret: body.secret,
        replacesCredentialId: body.replacesCredentialId,
        correlationId: body.correlationId,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      }),
      201,
    );
  } catch (error) {
    return adminFailure(error, body.correlationId);
  }
}
