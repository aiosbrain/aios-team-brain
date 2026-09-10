import type { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { rateLimitWithReset } from "@/lib/api/rate-limit";
import { adminClient } from "@/lib/db/admin";
import { parseIntakeBody } from "@/lib/codebases/debt-intake-body";
import { IntakeValidationError } from "@/lib/codebases/debt-intake-validation";
import { DebtIntakeError, ingestDebtIntake } from "@/lib/codebases/debt-intake";
import { intakeRegistry } from "@/lib/codebases/debt-intake-registry";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateApiKey(req, { recordUsage: false });
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") return errorResponse("forbidden_tier", "team posture required", 403);
  const decision = await rateLimitWithReset(adminClient(), `${auth.apiKeyId}:debt-intake:post`, 60);
  if (!decision.allowed) {
    const response = errorResponse("rate_limited", "60 intake requests/min per key", 429);
    response.headers.set("Retry-After", String(decision.retryAfterSeconds));
    return response;
  }
  const registry = intakeRegistry(auth.teamId);
  if (!registry || !Object.hasOwn(registry.uploaders, auth.apiKeyId)) {
    return errorResponse("forbidden_producer", "producer uploader not authorized", 403);
  }
  try {
    const payload = await parseIntakeBody(req);
    const { slug } = await context.params;
    const result = await ingestDebtIntake(auth, slug, payload.events, registry);
    return Response.json({ status: "ok", accepted_event_ids: result.accepted_event_ids,
      duplicate_event_ids: result.duplicate_event_ids }, { status: result.status });
  } catch (error) {
    if (error instanceof IntakeValidationError || error instanceof DebtIntakeError) {
      return errorResponse(error.code, error.code, error.status);
    }
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "55P03" || code === "57014" || code === "40P01" || code === "40001") {
      const response = errorResponse("intake_busy", "retry intake request", 503);
      response.headers.set("Retry-After", "2");
      return response;
    }
    return errorResponse("internal", "intake failed", 500);
  }
}
