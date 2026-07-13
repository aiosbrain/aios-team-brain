import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import {
  getProjectionHealth,
  listRecentProjectionRuns,
} from "@/lib/pm-sync/runs";

export const runtime = "nodejs";

export function parseProjectionRunLimit(raw: string | null): number {
  const requested = Number(raw ?? 10);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(50, Math.trunc(requested)))
    : 10;
}

/** Team-key projection observability for CLI and agent callers (brain-api v1.9). */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth)
    return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") {
    return errorResponse(
      "forbidden",
      "projection health requires a team-tier key",
      403,
    );
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:pm-sync-health:get`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  const limit = parseProjectionRunLimit(
    new URL(req.url).searchParams.get("limit"),
  );
  const [health, runs] = await Promise.all([
    getProjectionHealth(db, auth.teamId),
    listRecentProjectionRuns(db, auth.teamId, limit),
  ]);
  return Response.json({ health, runs });
}
