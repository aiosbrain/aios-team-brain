import { randomUUID } from "node:crypto";
import { decryptSecret } from "@/lib/secrets/crypto";
import { canonicalize } from "@/lib/gateway/canonical";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
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
  gatewayRequestHash,
  normalizeGatewayArgs,
} from "@/lib/gateway/normalize";
import {
  authorizeLeaseAndCreateExecution,
  failGatewayCredentialSealing,
  GatewayConflictError,
  GatewayPersistenceError,
  getGatewayCredentialForClaimedExecution,
  reboundMemberForLease,
} from "@/lib/gateway/persistence";
import { sealCredential } from "@/lib/gateway/sealed-credential";
import { GATEWAY_TOOLKIT } from "@/lib/gateway/types";

export async function POST(req: Request) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const auth = await authenticateGatewayRequest(req);
  if (isResponse(auth)) return auth;
  let correlationId: string | null = null;
  try {
    const limited = await enforceGatewayLimit(
      `gateway:${auth.id}:authorize`,
      120,
    );
    if (limited) return limited;
    const body = await readGatewayJson(req);
    if (isResponse(body)) return body;
    if (
      !exactObject(body, [
        "lease",
        "toolkit",
        "tool",
        "normalizedArgs",
        "requestHash",
        "correlationId",
        "idempotencyKey",
      ]) ||
      typeof body.lease !== "string" ||
      !body.lease ||
      body.toolkit !== GATEWAY_TOOLKIT ||
      typeof body.tool !== "string" ||
      typeof body.requestHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.requestHash) ||
      !isUuid(body.correlationId) ||
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey
    )
      return gatewayError("gateway_invalid_request", 400);
    correlationId = body.correlationId;
    const memberId = await reboundMemberForLease({
      serviceIdentityId: auth.id,
      lease: body.lease,
      audience: GATEWAY_TOOLKIT,
    });
    const memberLimited = await enforceGatewayLimit(
      `gateway:member:${memberId}:authorize`,
      120,
    );
    if (memberLimited) return memberLimited;
    let normalized;
    try {
      normalized = normalizeGatewayArgs(body.tool, body.normalizedArgs);
    } catch {
      return gatewayError("gateway_invalid_request", 400, correlationId);
    }
    if (
      canonicalize(normalized) !== canonicalize(body.normalizedArgs as never) ||
      gatewayRequestHash(normalized) !== body.requestHash
    )
      return gatewayError("gateway_invalid_request", 400, correlationId);
    const executionId = randomUUID();
    const envelope = encryptGatewayRequestEnvelope(normalized, {
      executionId,
      serviceIdentityId: auth.id,
    });
    const decision = await authorizeLeaseAndCreateExecution({
      serviceIdentityId: auth.id,
      executionId,
      lease: body.lease,
      audience: GATEWAY_TOOLKIT,
      toolkit: GATEWAY_TOOLKIT,
      tool: body.tool,
      normalizedArgs: normalized as {
        owner: string;
        repo: string;
        [key: string]: string | number;
      },
      requestHash: body.requestHash,
      correlationId,
      idempotencyKey: body.idempotencyKey,
      requestEnvelope: envelope,
    });
    if (decision.decision === "block")
      return gatewayJson({ ...decision, code: "policy_denied" }, 403);
    if (decision.decision === "require_approval")
      return gatewayJson(decision, 202);
    try {
      const stored = await getGatewayCredentialForClaimedExecution({
        serviceIdentityId: auth.id,
        executionId: decision.executionId,
      });
      const plaintext = Buffer.from(decryptSecret(stored.ciphertext), "utf8");
      try {
        const sealed = sealCredential({
          pat: plaintext,
          serviceSecret: auth.secretBytes,
          credentialId: auth.credentialId,
          credentialVersion: auth.credentialVersion,
          serviceIdentityId: auth.id,
          executionId: decision.executionId,
        });
        return gatewayJson({
          decision: "allow",
          executionId: decision.executionId,
          sealedCredential: sealed.sealedCredential,
          credentialExpiresAt: stored.credentialExpiresAt,
        });
      } finally {
        plaintext.fill(0);
      }
    } catch {
      await failGatewayCredentialSealing({
        serviceIdentityId: auth.id,
        executionId: decision.executionId,
        correlationId,
      });
      return gatewayError("gateway_credential_failure", 500, correlationId);
    }
  } catch (error) {
    if (error instanceof GatewayConflictError)
      return gatewayError(error.code, 409, correlationId);
    if (error instanceof GatewayPersistenceError)
      return gatewayError(error.code, 409, correlationId);
    return gatewayError("gateway_internal", 500, correlationId);
  } finally {
    auth.secretBytes.fill(0);
  }
}
