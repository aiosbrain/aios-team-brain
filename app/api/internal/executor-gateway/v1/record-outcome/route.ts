import {
  authenticateGatewayRequest,
  enforceGatewayLimit,
  exactObject,
  gatewayDisabled,
  gatewayError,
  isResponse,
  isUuid,
  readGatewayJson,
} from "@/lib/gateway/http";
import {
  GatewayPersistenceError,
  recordGatewayOutcome,
} from "@/lib/gateway/persistence";

const classifications = [
  "success",
  "blocked",
  "approval_required",
  "credential",
  "network",
  "upstream",
  "response_too_large",
  "internal",
];
export async function POST(req: Request) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const auth = await authenticateGatewayRequest(req);
  if (isResponse(auth)) return auth;
  let correlationId: string | null = null;
  try {
    const limited = await enforceGatewayLimit(
      `gateway:${auth.id}:outcome`,
      240,
    );
    if (limited) return limited;
    const body = await readGatewayJson(req);
    if (isResponse(body)) return body;
    if (
      !exactObject(
        body,
        ["executionId", "correlationId", "classification"],
        ["upstreamStatusClass", "responseBytes"],
      ) ||
      !isUuid(body.executionId) ||
      !isUuid(body.correlationId) ||
      typeof body.classification !== "string" ||
      !classifications.includes(body.classification) ||
      (body.upstreamStatusClass !== undefined &&
        !["2xx", "3xx", "4xx", "5xx"].includes(
          body.upstreamStatusClass as string,
        )) ||
      (body.responseBytes !== undefined &&
        (!Number.isSafeInteger(body.responseBytes) ||
          Number(body.responseBytes) < 0))
    )
      return gatewayError("gateway_invalid_request", 400);
    correlationId = body.correlationId;
    await recordGatewayOutcome({
      serviceIdentityId: auth.id,
      executionId: body.executionId,
      correlationId,
      classification: body.classification,
      upstreamStatusClass: body.upstreamStatusClass as string | undefined,
      responseBytes: body.responseBytes as number | undefined,
    });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof GatewayPersistenceError)
      return gatewayError(error.code, 409, correlationId);
    if (error instanceof Error && error.message === "gateway_outcome_conflict")
      return gatewayError("gateway_outcome_conflict", 409, correlationId);
    return gatewayError("gateway_internal", 500, correlationId);
  } finally {
    auth.secretBytes.fill(0);
  }
}
