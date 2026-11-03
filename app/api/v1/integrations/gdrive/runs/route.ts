import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { adminClient } from "@/lib/db/admin";
import { recordIngestRun } from "@/lib/ingest/runs";
import {
  claimGdriveRun, completeGdriveRun, GdriveScheduledReportRefused, recordScheduledGdriveRun,
} from "@/lib/integrations/gdrive-runs";
// A verified busy deferral and healthy partial progress append NOTHING to the run ledger: neither
// a failure (two would confirm a false banner) nor a success (it could clear a real one).
import { gdriveLedgerDisposition } from "@/lib/integrations/gdrive-run-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const outcomeFields = {
  status: z.enum(["complete", "partial", "failed", "deferred"]),
  created: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0),
  unchanged: z.number().int().nonnegative().default(0),
  removed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  backlog: z.number().int().nonnegative().nullable().optional(),
  cursorAgeSeconds: z.number().nonnegative().nullable().optional(),
  authoritativeComplete: z.boolean().default(false),
  error: z.string().max(500).optional(),
};
const outcomeSchema = z.union([
  // A claimed request is reported only with the attempt token its claim returned.
  z.object({ requestId: z.string().uuid(), attemptToken: z.string().uuid(), ...outcomeFields }).strict(),
  z.object({ reportId: z.string().uuid(), integrationId: z.string().uuid(), trigger: z.literal("scheduler"),
    // The sidecar sends Python's `isoformat()` ("…T10:00:00.123456+00:00"); an offset is valid ISO.
    startedAt: z.string().datetime({ offset: true }), ...outcomeFields }).strict(),
]);

async function connector(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth || !auth.isConnector || auth.actorHandle !== "gdrive-sync" || auth.memberTier !== "team") return null;
  return auth;
}

/** Seconds a connector should wait before re-sending a report the brain could not record. */
const REPORT_RETRY_AFTER_SECONDS = 30;

/**
 * A typed refusal is final and keeps its fixed 409; anything else is infrastructure (database, lock
 * or connection) and is a fixed, retryable 503. Raw database text is logged here, never returned.
 */
function scheduledReportFailure(error: unknown): Response {
  if (error instanceof GdriveScheduledReportRefused) {
    return error.code === "stale_authority"
      ? errorResponse("stale_execution", "Google Drive scheduled report authority is stale", 409)
      : errorResponse("conflicting_report", "Google Drive scheduled report conflicts with the recorded report", 409);
  }
  console.error("[gdrive/runs] scheduled report not recorded:", error instanceof Error ? error.message : error);
  const response = errorResponse("report_unavailable", "Google Drive scheduled report could not be recorded; retry later", 503);
  response.headers.set("Retry-After", String(REPORT_RETRY_AFTER_SECONDS));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** Claim one pending request bound to this immutable connector key. */
export async function GET(req: NextRequest) {
  const auth = await connector(req);
  if (!auth) return errorResponse("unauthorized", "trusted Google Drive connector principal required", 401);
  const request = await claimGdriveRun({
    teamId: auth.teamId, apiKeyId: auth.apiKeyId, memberId: auth.memberId,
  });
  return Response.json({ request }, { headers: { "Cache-Control": "no-store" } });
}

/** Record the coordinator's terminal/partial summary and append the normal Admin run ledger. */
export async function POST(req: NextRequest) {
  const auth = await connector(req);
  if (!auth) return errorResponse("unauthorized", "trusted Google Drive connector principal required", 401);
  const parsed = outcomeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("invalid_payload", "invalid Google Drive run outcome", 422);
  const outcome = parsed.data;
  // Decided once for both report kinds: a neutral outcome keeps its durable report but appends no
  // ledger row (`lib/integrations/gdrive-run-ledger`).
  const disposition = gdriveLedgerDisposition(outcome);
  const summary = {
        created: outcome.created, updated: outcome.updated, unchanged: outcome.unchanged,
        removed: outcome.removed, failed: outcome.failed, skipped: outcome.skipped,
        backlog: outcome.backlog ?? null, cursorAgeSeconds: outcome.cursorAgeSeconds ?? null,
        authoritativeComplete: outcome.authoritativeComplete,
  };
  if ("reportId" in outcome) {
    try {
      const completed = await recordScheduledGdriveRun({
        reportId: outcome.reportId, integrationId: outcome.integrationId, teamId: auth.teamId,
        apiKeyId: auth.apiKeyId, memberId: auth.memberId, status: outcome.status,
        summary, error: outcome.error, startedAt: outcome.startedAt,
      });
      // The durable report above is kept either way; a neutral outcome only skips the ledger append.
      if (completed.newly_completed && disposition !== "neutral") await recordIngestRun(adminClient(), {
        teamId: auth.teamId, source: "gdrive", trigger: "scheduler",
        ok: disposition === "success",
        created: outcome.created, updated: outcome.updated, unchanged: outcome.unchanged,
        errors: outcome.error ? [outcome.error] : outcome.failed ? [`${outcome.failed} Drive work item(s) failed`] : [],
        meta: { reportId: outcome.reportId, status: outcome.status, removed: outcome.removed,
          skipped: outcome.skipped, authoritativeComplete: outcome.authoritativeComplete,
          backlog: outcome.backlog ?? null, cursorAgeSeconds: outcome.cursorAgeSeconds ?? null },
        startedAt: new Date(completed.started_at).getTime(),
      });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return scheduledReportFailure(error);
    }
  }
  const completed = await completeGdriveRun({
    requestId: outcome.requestId, attemptToken: outcome.attemptToken, teamId: auth.teamId,
    apiKeyId: auth.apiKeyId, memberId: auth.memberId,
    status: outcome.status, summary, error: outcome.error,
  });
  if (!completed) return errorResponse("stale_execution", "Google Drive run attempt is no longer current", 409);
  if (completed.newly_completed && disposition !== "neutral") await recordIngestRun(adminClient(), {
    teamId: auth.teamId, source: "gdrive", trigger: "manual",
    ok: disposition === "success",
    created: outcome.created, updated: outcome.updated, unchanged: outcome.unchanged,
    errors: outcome.error ? [outcome.error] : outcome.failed ? [`${outcome.failed} Drive work item(s) failed`] : [],
    meta: { requestId: outcome.requestId, requestTrigger: completed.trigger, status: outcome.status,
      removed: outcome.removed, skipped: outcome.skipped, authoritativeComplete: outcome.authoritativeComplete,
      backlog: outcome.backlog ?? null, cursorAgeSeconds: outcome.cursorAgeSeconds ?? null },
    startedAt: new Date(completed.started_at).getTime(),
  });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
