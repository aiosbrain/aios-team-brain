import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { usageCostPayloadSchema, errorResponse, IngestValidationError } from "@/lib/api/schemas";
import { ingestUsageCost } from "@/lib/costs/ingest";

export const runtime = "nodejs";

const MAX_PAYLOAD = 50_000;

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  // PRET-4 §1d correction (recorded in the spec): this is the cost-INGEST write, an OPS
  // surface — the gate stays, with POSTURE as its input (memberTier is membership-derived at
  // the auth boundary since PRET-4; the members.tier record is not consulted). The money READ
  // ruling (admin: company bill; member: own usage) lands on the costs page and its data
  // functions, not here.
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "cost ingestion is a team-posture operation", 403);
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:costs:post`, 120))) {
    return errorResponse("rate_limited", "120 cost pushes/min per key", 429);
  }

  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_PAYLOAD * 1.2) return errorResponse("payload_too_large", "max 50 KB", 413);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }

  const parsed = usageCostPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }

  try {
    const result = await ingestUsageCost(db, auth, parsed.data);
    return Response.json({ status: "ok", ...result }, { status: 201 });
  } catch (e) {
    // An unknown member handle is a client input error (the caller sent a handle the team
    // doesn't have), not a brain fault — surface 422 so the CLI gets a structured signal.
    if (e instanceof IngestValidationError) {
      return errorResponse("invalid_payload", e.message, 422);
    }
    return errorResponse("internal", e instanceof Error ? e.message : "cost ingest failed", 500);
  }
}
