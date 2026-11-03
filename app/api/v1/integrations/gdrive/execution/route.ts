import { NextRequest } from "next/server";
import { z } from "zod";

import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimitWithReset } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { adminClient } from "@/lib/db/admin";
import {
  acquireGdriveExecution,
  authorizeGdriveProviderCall,
  checkpointGdriveExecution,
  GdriveAuthorityError,
  releaseGdriveExecution,
  verifyGdriveServiceAccount,
} from "@/lib/integrations/gdrive-authority";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acquire"), integration_id: z.string().uuid(), owner: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("verify_service_account"), integration_id: z.string().uuid(), owner: z.string().uuid(),
    generation: z.number().int().positive(), fence: z.number().int().positive(),
    identity: z.string().email().max(320),
  }).strict(),
  z.object({
    action: z.literal("authorize_provider"), integration_id: z.string().uuid(), owner: z.string().uuid(),
    generation: z.number().int().positive(), fence: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("checkpoint"), integration_id: z.string().uuid(), owner: z.string().uuid(),
    generation: z.number().int().positive(), fence: z.number().int().positive(),
    progress_revision: z.number().int().nonnegative(),
    progress: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    action: z.literal("release"), integration_id: z.string().uuid(), owner: z.string().uuid(),
    generation: z.number().int().positive(), fence: z.number().int().positive(),
  }).strict(),
]);

function failure(error: unknown): Response {
  if (error instanceof GdriveAuthorityError) return errorResponse(error.code, error.message, error.status);
  return errorResponse("internal", "Google Drive execution authority unavailable", 500);
}

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  const quota = parsed.data.action === "authorize_provider"
    ? { bucket: "provider", limit: 20_000 }
    : parsed.data.action === "checkpoint"
      ? { bucket: "progress", limit: 240 }
      : parsed.data.action === "release"
        ? { bucket: "release", limit: 600 }
        : { bucket: "lifecycle", limit: 60 };
  const decision = await rateLimitWithReset(
    adminClient(), `${auth.apiKeyId}:gdrive:${quota.bucket}`, quota.limit,
  );
  if (!decision.allowed) {
    const response = errorResponse("rate_limited", `${quota.limit} operations/min per connector`, 429);
    response.headers.set("Retry-After", String(decision.retryAfterSeconds));
    return response;
  }
  try {
    const body = parsed.data;
    if (body.action === "acquire") {
      const execution = await acquireGdriveExecution(auth, body.integration_id, body.owner);
      return Response.json({
        integration_id: execution.integrationId, generation: execution.generation,
        fence: execution.fence, owner: execution.owner, lease_expires_at: execution.leaseExpiresAt,
        scope_hash: execution.scopeHash, config: execution.config,
        progress: execution.progress, progress_revision: execution.progressRevision,
      }, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
    }
    const ref = { integrationId: body.integration_id, generation: body.generation, fence: body.fence, owner: body.owner };
    if (body.action === "authorize_provider") {
      const result = await authorizeGdriveProviderCall(auth, ref);
      return Response.json({ ok: true, lease_expires_at: result.leaseExpiresAt }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "checkpoint") {
      const result = await checkpointGdriveExecution(auth, ref, body.progress, body.progress_revision);
      return Response.json({
        ok: true, lease_expires_at: result.leaseExpiresAt,
        progress: result.progress, progress_revision: result.progressRevision,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "verify_service_account") {
      await verifyGdriveServiceAccount(auth, ref, body.identity);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    await releaseGdriveExecution(auth, ref);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
