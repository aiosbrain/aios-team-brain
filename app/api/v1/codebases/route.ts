import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { codebaseScanPayloadSchema, errorResponse } from "@/lib/api/schemas";
import { ingestCodebaseScan } from "@/lib/codebases/ingest";
import { recordIngestRun, type IngestTrigger } from "@/lib/ingest/runs";

// Known callers set X-AIOS-Trigger so the runs log distinguishes a merge scan from an ad-hoc one.
const KNOWN_TRIGGERS = new Set<IngestTrigger>(["scheduler", "manual", "merge", "cli", "api"]);

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

  // Record the scan outcome (success OR failure) so a broken scan is diagnosable — this is the exact
  // path that silently failed for weeks. Trigger comes from the caller's header when set.
  const startedAt = Date.now();
  const hdr = (req.headers.get("x-aios-trigger") || "").toLowerCase() as IngestTrigger;
  const trigger: IngestTrigger = KNOWN_TRIGGERS.has(hdr) ? hdr : "api";
  const slug = parsed.data.codebase.slug;
  const headSha = parsed.data.metrics?.head_sha;

  try {
    const result = await ingestCodebaseScan(supabase, auth, parsed.data);
    await recordIngestRun(supabase, {
      teamId: auth.teamId,
      source: "scan",
      trigger,
      ok: true,
      updated: result.contributions, // scans upsert contributor rollups (no clean created/updated split)
      meta: { slug, head_sha: headSha, contributions: result.contributions, issues: result.issues },
      startedAt,
    });
    return Response.json({ status: "ok", ...result }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "scan ingest failed";
    await recordIngestRun(supabase, {
      teamId: auth.teamId,
      source: "scan",
      trigger,
      ok: false,
      errors: [msg],
      meta: { slug, head_sha: headSha },
      startedAt,
    });
    return errorResponse("internal", msg, 500);
  }
}
