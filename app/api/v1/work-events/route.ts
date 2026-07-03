import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse, workEventPayloadSchema } from "@/lib/api/schemas";
import { ingestWorkEvent } from "@/lib/work-events/ingest";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "work events are team-tier only", 403);
  }

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:work-events:post`, 60))) {
    return errorResponse("rate_limited", "60 work events/min per key", 429);
  }

  const parsed = workEventPayloadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.message, 422);
  }

  try {
    const result = await ingestWorkEvent(
      supabase,
      { teamId: auth.teamId, memberId: auth.memberId, apiKeyId: auth.apiKeyId },
      parsed.data
    );
    return Response.json(result, { status: 201 });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "failed", 500);
  }
}
