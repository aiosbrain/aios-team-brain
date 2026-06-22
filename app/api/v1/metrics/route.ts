import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import {
  maturitySnapshotPayloadSchema,
  errorResponse,
  IngestValidationError,
} from "@/lib/api/schemas";
import { ingestMaturitySnapshot } from "@/lib/metrics/individual-maturity-ingest";

export const runtime = "nodejs";

const MAX_PAYLOAD = 100_000; // 100 KB — one day's aggregate is tiny (ratios + counts)

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  // Agentic-maturity is team-tier only: an external-tier key may neither push nor read.
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "agentic-maturity metrics are team-tier only", 403);
  }

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:metrics:post`, 60))) {
    return errorResponse("rate_limited", "60 snapshots/min per key", 429);
  }

  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_PAYLOAD * 1.2) return errorResponse("payload_too_large", "max 100 KB", 413);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }

  const parsed = maturitySnapshotPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }

  try {
    const result = await ingestMaturitySnapshot(supabase, auth, parsed.data);
    return Response.json({ status: "ok", ...result }, { status: 201 });
  } catch (e) {
    // Unknown member handle = client input error → 422, not a 500 brain fault.
    if (e instanceof IngestValidationError) {
      return errorResponse("invalid_payload", e.message, 422);
    }
    return errorResponse("internal", e instanceof Error ? e.message : "snapshot ingest failed", 500);
  }
}
