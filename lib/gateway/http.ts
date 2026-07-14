import "server-only";
import { randomUUID } from "node:crypto";
import { GATEWAY_CONTRACT_VERSION } from "@/lib/api/version";
import {
  authenticateGatewayServiceCredential,
  GatewayAuthenticationError,
  gatewayRateLimit,
  type AuthenticatedGatewayService,
} from "./persistence";

export const GATEWAY_MAX_RAW_BODY_BYTES = 65_536;
const messages: Record<string, string> = {
  gateway_unauthorized: "Unauthorized",
  gateway_version_mismatch: "Gateway version mismatch",
  gateway_invalid_request: "Invalid request",
  gateway_payload_too_large: "Request body too large",
  gateway_unsupported_content_encoding: "Unsupported content encoding",
  gateway_rate_limited: "Rate limit exceeded",
  gateway_not_found: "Not found",
  gateway_scope_not_found: "Gateway scope not found",
  gateway_lease_invalid: "Invalid lease",
  gateway_policy_stale: "Gateway policy changed",
  gateway_allow_already_committed: "Allow already committed",
  gateway_idempotency_conflict: "Idempotency conflict",
  gateway_outcome_conflict: "Outcome conflict",
  gateway_credential_failure: "Credential unavailable",
  gateway_internal: "Internal gateway error",
};
const noStore = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};

export function gatewayError(
  code: string,
  status: number,
  correlationId: string | null = null,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: messages[code] ?? messages.gateway_internal,
        request_id: randomUUID(),
        correlation_id: correlationId,
      },
    }),
    { status, headers: { ...noStore, ...extraHeaders } },
  );
}
export function gatewayJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: noStore });
}
export function gatewayDisabled(): Response | null {
  return process.env.AIOS_GATEWAY_INTERNAL_ENABLED === "true"
    ? null
    : gatewayError("gateway_not_found", 404);
}

export async function authenticateGatewayRequest(
  req: Request,
): Promise<AuthenticatedGatewayService | Response> {
  try {
    const service = await authenticateGatewayServiceCredential(
      req.headers.get("authorization"),
    );
    if (
      req.headers.get("x-aios-executor-version") !== "1.5.33" ||
      req.headers.get("x-aios-companion-version") !== "0.1.0" ||
      req.headers.get("x-aios-contract-version") !== GATEWAY_CONTRACT_VERSION
    ) {
      service.secretBytes.fill(0);
      return gatewayError("gateway_version_mismatch", 409);
    }
    return service;
  } catch (error) {
    return error instanceof GatewayAuthenticationError
      ? gatewayError("gateway_unauthorized", 401)
      : gatewayError("gateway_internal", 500);
  }
}

export async function readGatewayJson(
  req: Request,
): Promise<unknown | Response> {
  const encoding = req.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity")
    return gatewayError("gateway_unsupported_content_encoding", 415);
  const declared = req.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > GATEWAY_MAX_RAW_BODY_BYTES)
  )
    return gatewayError("gateway_payload_too_large", 413);
  if (!req.body) return gatewayError("gateway_invalid_request", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > GATEWAY_MAX_RAW_BODY_BYTES) {
          await reader.cancel();
          return gatewayError("gateway_payload_too_large", 413);
        }
        chunks.push(value);
      }
    }
  } catch {
    return gatewayError("gateway_invalid_request", 400);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return gatewayError("gateway_invalid_request", 400);
  }
}

export async function enforceGatewayLimit(
  bucket: string,
  limit: number,
): Promise<Response | null> {
  try {
    const hit = await gatewayRateLimit(bucket, limit);
    return hit.allowed
      ? null
      : gatewayError("gateway_rate_limited", 429, null, {
          "Retry-After": String(hit.retryAfter),
        });
  } catch {
    return gatewayError("gateway_rate_limited", 429, null, {
      "Retry-After": "60",
    });
  }
}

export const isResponse = (value: unknown): value is Response =>
  value instanceof Response;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const exactObject = (
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
