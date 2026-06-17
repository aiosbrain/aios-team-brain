import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { codebaseScanPayloadSchema, errorResponse } from "@/lib/api/schemas";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";

export const runtime = "nodejs";

const MAX_PAYLOAD = 2_000_000; // 2 MB — scans carry per-author/day rollups + issues

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  // Codebase analytics are team-tier only: an external-tier key may neither push nor read.
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "codebase metrics are team-tier only", 403);
  }

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:codebases:post`, 60))) {
    return errorResponse("rate_limited", "60 scans/min per key", 429);
  }

  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_PAYLOAD * 1.2) return errorResponse("payload_too_large", "max 2 MB", 413);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }

  const parsed = codebaseScanPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }

  try {
    const result = await ingestCodebaseScan(supabase, auth, parsed.data);
    return Response.json({ status: "ok", ...result }, { status: 201 });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "scan ingest failed", 500);
  }
}
