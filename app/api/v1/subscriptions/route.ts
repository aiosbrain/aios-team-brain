import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import {
  subscriptionPayloadSchema,
  errorResponse,
  IngestValidationError,
} from "@/lib/api/schemas";
import { ingestSubscription } from "@/lib/subscriptions/ingest";

export const runtime = "nodejs";

const MAX_PAYLOAD = 4_000;

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth)
    return errorResponse("unauthorized", "invalid API key or team", 401);

  if (auth.memberTier !== "team") {
    return errorResponse(
      "forbidden_tier",
      "subscriptions are team-tier only",
      403,
    );
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:subscriptions:post`, 60))) {
    return errorResponse(
      "rate_limited",
      "60 subscription pushes/min per key",
      429,
    );
  }

  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_PAYLOAD * 1.2)
    return errorResponse("payload_too_large", "max 4 KB", 413);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }

  const parsed = subscriptionPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      "invalid_payload",
      parsed.error.issues[0]?.message ?? "invalid",
      422,
    );
  }

  try {
    const result = await ingestSubscription(db, auth, parsed.data);
    return Response.json({ status: "ok", ...result }, { status: 201 });
  } catch (e) {
    // An unknown member handle is a client input error, not a brain fault → 422.
    if (e instanceof IngestValidationError) {
      return errorResponse("invalid_payload", e.message, 422);
    }
    return errorResponse(
      "internal",
      e instanceof Error ? e.message : "subscription ingest failed",
      500,
    );
  }
}
