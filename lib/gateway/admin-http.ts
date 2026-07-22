import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeGatewayAdmin,
  GatewayAdminError,
  type GatewayAdminContext,
} from "./admin-persistence";
import { gatewayError } from "./http";

export async function gatewayAdminContext(
  teamSlug: string,
): Promise<GatewayAdminContext | Response> {
  const user = await getSessionUser();
  if (!user) return gatewayError("gateway_unauthorized", 401);
  try {
    return await authorizeGatewayAdmin(teamSlug, user.id);
  } catch (error) {
    return error instanceof GatewayAdminError
      ? gatewayError(error.code, error.status)
      : gatewayError("gateway_internal", 500);
  }
}

export const adminFailure = (error: unknown, correlationId: string | null = null) =>
  error instanceof GatewayAdminError
    ? gatewayError(error.code, error.status, correlationId)
    : gatewayError("gateway_internal", 500, correlationId);
