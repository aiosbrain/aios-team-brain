import {
  authenticateGatewayRequest,
  enforceGatewayLimit,
  exactObject,
  gatewayDisabled,
  gatewayError,
  gatewayJson,
  isResponse,
  isUuid,
  readGatewayJson,
} from "@/lib/gateway/http";
import {
  GatewayPersistenceError,
  resolveAndIssueLease,
} from "@/lib/gateway/persistence";

export async function POST(req: Request) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const auth = await authenticateGatewayRequest(req);
  if (isResponse(auth)) return auth;
  try {
    const limited = await enforceGatewayLimit(
      `gateway:${auth.id}:resolve`,
      120,
    );
    if (limited) return limited;
    const body = await readGatewayJson(req);
    if (isResponse(body)) return body;
    if (
      !exactObject(body, [
        "executorTenantId",
        "executorSubjectId",
        "connectionRef",
        "correlationId",
      ]) ||
      typeof body.executorTenantId !== "string" ||
      !body.executorTenantId ||
      typeof body.executorSubjectId !== "string" ||
      !body.executorSubjectId ||
      typeof body.connectionRef !== "string" ||
      !body.connectionRef ||
      !isUuid(body.correlationId)
    )
      return gatewayError("gateway_invalid_request", 400);
    return gatewayJson(
      await resolveAndIssueLease({
        serviceIdentityId: auth.id,
        executorTenantId: body.executorTenantId,
        executorSubjectId: body.executorSubjectId,
        connectionRef: body.connectionRef,
        audience: "aios-github-readonly",
        correlationId: body.correlationId,
      }),
    );
  } catch (error) {
    return error instanceof GatewayPersistenceError
      ? gatewayError(error.code, 422)
      : gatewayError("gateway_internal", 500);
  } finally {
    auth.secretBytes.fill(0);
  }
}
