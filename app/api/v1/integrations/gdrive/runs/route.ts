import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { adminClient } from "@/lib/db/admin";
import { recordIngestRun } from "@/lib/ingest/runs";
import { claimGdriveRun, completeGdriveRun, recordScheduledGdriveRun } from "@/lib/integrations/gdrive-runs";

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
    startedAt: z.string().datetime(), ...outcomeFields }).strict(),
]);

type Outcome = z.infer<typeof outcomeSchema>;

/**
 * A scheduled or notification run that never started because another coordinator held the
 * connection's execution lease (`execution_busy`). It read and wrote nothing: the other run owns the
 * work, and any undrained hint stays pending for it. It is neither a success nor a failure, so it
 * appends nothing to the Admin run ledger — an `ok:false` row would let two busy wakes confirm a
 * failure banner, and an `ok:true` row could clear a real one. Only the exact busy shape is exempt:
 * a deferral that also reports failures, work or a different cause is not.
 */
function isVerifiedBusyDeferral(outcome: Outcome): boolean {
  return outcome.status === "deferred"
    && outcome.error === "execution_busy"
    && outcome.failed === 0
    && outcome.created === 0 && outcome.updated === 0 && outcome.unchanged === 0 && outcome.removed === 0
    && !outcome.authoritativeComplete;
}

async function connector(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth || !auth.isConnector || auth.actorHandle !== "gdrive-sync" || auth.memberTier !== "team") return null;
  return auth;
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
      // The durable deferred report above is kept either way; only the ledger append is skipped.
      if (completed.newly_completed && !isVerifiedBusyDeferral(outcome)) await recordIngestRun(adminClient(), {
        teamId: auth.teamId, source: "gdrive", trigger: "scheduler",
        ok: outcome.status === "complete" && outcome.failed === 0,
        created: outcome.created, updated: outcome.updated, unchanged: outcome.unchanged,
        errors: outcome.error ? [outcome.error] : outcome.failed ? [`${outcome.failed} Drive work item(s) failed`] : [],
        meta: { reportId: outcome.reportId, status: outcome.status, removed: outcome.removed,
          skipped: outcome.skipped, authoritativeComplete: outcome.authoritativeComplete,
          backlog: outcome.backlog ?? null, cursorAgeSeconds: outcome.cursorAgeSeconds ?? null },
        startedAt: new Date(completed.started_at).getTime(),
      });
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return errorResponse("stale_execution", "Google Drive scheduled report authority is stale", 409);
    }
  }
  const completed = await completeGdriveRun({
    requestId: outcome.requestId, attemptToken: outcome.attemptToken, teamId: auth.teamId,
    apiKeyId: auth.apiKeyId, memberId: auth.memberId,
    status: outcome.status, summary, error: outcome.error,
  });
  if (!completed) return errorResponse("stale_execution", "Google Drive run attempt is no longer current", 409);
  if (completed.newly_completed) await recordIngestRun(adminClient(), {
    teamId: auth.teamId, source: "gdrive", trigger: "manual",
    ok: outcome.status === "complete" && outcome.failed === 0,
    created: outcome.created, updated: outcome.updated, unchanged: outcome.unchanged,
    errors: outcome.error ? [outcome.error] : outcome.failed ? [`${outcome.failed} Drive work item(s) failed`] : [],
    meta: { requestId: outcome.requestId, requestTrigger: completed.trigger, status: outcome.status,
      removed: outcome.removed, skipped: outcome.skipped, authoritativeComplete: outcome.authoritativeComplete,
      backlog: outcome.backlog ?? null, cursorAgeSeconds: outcome.cursorAgeSeconds ?? null },
    startedAt: new Date(completed.started_at).getTime(),
  });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
