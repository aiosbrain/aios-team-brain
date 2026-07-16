import { decryptSecretBytes } from "@/lib/secrets/crypto";
import { canonicalize } from "@/lib/gateway/canonical";
import { decryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
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
  GATEWAY_TOOLS,
  gatewayRequestHash,
  normalizeGatewayArgs,
} from "@/lib/gateway/normalize";
import {
  failGatewayCredentialSealing,
  GatewayPersistenceError,
  resumeClaimGatewayExecution,
} from "@/lib/gateway/persistence";
import { sealCredential } from "@/lib/gateway/sealed-credential";
import { GATEWAY_TOOLKIT } from "@/lib/gateway/types";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const auth = await authenticateGatewayRequest(req);
  if (isResponse(auth)) return auth;
  let correlationId: string | null = null;
  let executionId = "";
  try {
    executionId = (await params).executionId;
    if (!isUuid(executionId))
      return gatewayError("gateway_not_found", 404);
    const limited = await enforceGatewayLimit(`gateway:${auth.id}:resume-claim`, 120);
    if (limited) return limited;
    const body = await readGatewayJson(req);
    if (isResponse(body)) return body;
    if (
      !exactObject(body, [
        "executorTenantId",
        "executorSubjectId",
        "toolkit",
        "tool",
        "requestHash",
        "correlationId",
        "idempotencyKey",
      ]) ||
      typeof body.executorTenantId !== "string" ||
      !body.executorTenantId ||
      typeof body.executorSubjectId !== "string" ||
      !body.executorSubjectId ||
      body.toolkit !== GATEWAY_TOOLKIT ||
      typeof body.tool !== "string" ||
      !GATEWAY_TOOLS.some((tool) => tool === body.tool) ||
      typeof body.requestHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.requestHash) ||
      !isUuid(body.correlationId) ||
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey
    )
      return gatewayError("gateway_invalid_request", 400);
    correlationId = body.correlationId;
    const result = await resumeClaimGatewayExecution({
      service: auth,
      executionId,
      executorTenantId: body.executorTenantId,
      executorSubjectId: body.executorSubjectId,
      toolkit: body.toolkit,
      tool: body.tool,
      requestHash: body.requestHash,
      correlationId,
      idempotencyKey: body.idempotencyKey,
      useWinningPayload: async (payload) => {
        const normalized = decryptGatewayRequestEnvelope<Record<string, unknown>>(
          payload.encryptedRequestEnvelope,
          { executionId: payload.executionId, serviceIdentityId: auth.id },
        );
        const checked = normalizeGatewayArgs(payload.tool, normalized);
        if (
          canonicalize(checked) !== canonicalize(normalized as never) ||
          gatewayRequestHash(checked) !== payload.requestHash
        )
          throw new Error("gateway_envelope_invalid");
        const plaintext = decryptSecretBytes(payload.credentialCiphertext);
        try {
          const sealed = sealCredential({
            pat: plaintext,
            serviceSecret: auth.secretBytes,
            credentialId: auth.credentialId,
            credentialVersion: auth.credentialVersion,
            serviceIdentityId: auth.id,
            executionId: payload.executionId,
          });
          return {
            status: "claimed" as const,
            executionId: payload.executionId,
            toolkit: payload.toolkit,
            tool: payload.tool,
            normalizedArgs: checked,
            sealedCredential: sealed.sealedCredential,
            credentialExpiresAt: payload.credentialExpiresAt,
          };
        } finally {
          plaintext.fill(0);
        }
      },
    });
    return gatewayJson(
      result.status === "claimed"
        ? result.value
        : {
            status: "already_claimed",
            executionId: result.executionId,
            state: result.state,
          },
    );
  } catch (error) {
    if (error instanceof GatewayPersistenceError) {
      const status =
        error.code === "gateway_not_found"
          ? 404
          : error.code === "gateway_approval_expired"
            ? 410
            : error.code === "gateway_scope_not_found"
              ? 422
              : error.code === "gateway_idempotency_conflict"
                ? 409
                : 422;
      return gatewayError(error.code, status, correlationId);
    }
    if (executionId && correlationId) {
      await failGatewayCredentialSealing({
        serviceIdentityId: auth.id,
        executionId,
        correlationId,
      }).catch(() => undefined);
    }
    return gatewayError("gateway_credential_failure", 500, correlationId);
  } finally {
    auth.secretBytes.fill(0);
  }
}
