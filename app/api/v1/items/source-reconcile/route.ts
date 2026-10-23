import { NextRequest } from "next/server";
import { z } from "zod";

import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { rateLimitWithReset } from "@/lib/api/rate-limit";
import {
  drainGdriveCleanupObligations,
  GDRIVE_SNAPSHOT_PAGE_LIMIT,
  GdriveSnapshotError,
  stageGdriveReconciliation,
} from "@/lib/ingest/source-reconcile";
import { GdriveAuthorityError, withGdriveExecutionCommit } from "@/lib/integrations/gdrive-authority";

export const runtime = "nodejs";

/**
 * PostgreSQL 55P03 (lock_not_available): a bounded lock acquisition ran out, here or wrapped by the
 * transaction layer (searched through a bounded cause chain by SQLSTATE, never by message text). The
 * reconciliation transaction rolled back whole, so the same request may simply be sent again.
 */
function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === current) break;
    current = cause;
  }
  return false;
}

const requestSchema = z.object({
  source: z.literal("gdrive"),
  integration_id: z.string().uuid(),
  generation: z.number().int().positive(),
  fence: z.number().int().positive(),
  owner: z.string().uuid(),
  removed_provider_ids: z.array(z.string().trim().min(1).max(500)).max(1_000).default([]),
  snapshot: z.object({
    complete: z.boolean(),
    provider_ids: z.array(z.string().trim().min(1).max(500)).max(GDRIVE_SNAPSHOT_PAGE_LIMIT),
    // A selection larger than one request: every page names the same snapshot and is only held;
    // the page marked complete states the whole snapshot's size and finalizes it atomically.
    snapshot_id: z.string().uuid().optional(),
    total: z.number().int().nonnegative().optional(),
    // A successor execution continuing a deferred upload proves the exact prefix it expects to find
    // held; `inspect` only asks how much is held and changes nothing.
    resume: z.object({
      members: z.number().int().positive(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict().optional(),
    inspect: z.boolean().optional(),
  }).refine(
    (snapshot) => (snapshot.snapshot_id !== undefined && snapshot.complete) === (snapshot.total !== undefined),
    { message: "snapshot.total is stated on, and only on, the completing page of a staged snapshot" },
  ).refine(
    (snapshot) => snapshot.snapshot_id !== undefined || (snapshot.resume === undefined && !snapshot.inspect),
    { message: "snapshot.resume and snapshot.inspect apply only to a staged snapshot" },
  ).refine(
    (snapshot) => !snapshot.inspect
      || (!snapshot.complete && snapshot.provider_ids.length === 0 && snapshot.resume === undefined),
    { message: "snapshot.inspect carries no members, no proof and no completion" },
  ).optional(),
  reason: z.string().trim().min(1).max(500),
}).strict();

/** Provider-confirmed removal and complete-snapshot reconciliation for connector workers. */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const db = adminClient();
  const quota = await rateLimitWithReset(db, `${auth.apiKeyId}:source-reconcile:post`, 30);
  if (!quota.allowed) {
    // A staged snapshot is many requests. The connector waits out exactly this window, or defers
    // the rest of the upload to its next run, instead of guessing a backoff.
    const response = errorResponse("rate_limited", "30 reconciliations/min per key", 429);
    response.headers.set("Retry-After", String(quota.retryAfterSeconds));
    return response;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }

  try {
    const staged = await withGdriveExecutionCommit(auth, {
      integrationId: parsed.data.integration_id, generation: parsed.data.generation,
      fence: parsed.data.fence, owner: parsed.data.owner,
    }, () => stageGdriveReconciliation(
      db, auth.teamId,
      {
        connectionId: parsed.data.integration_id,
        removedProviderIds: parsed.data.removed_provider_ids,
        snapshot: parsed.data.snapshot
          ? {
              complete: parsed.data.snapshot.complete,
              providerIds: parsed.data.snapshot.provider_ids,
              // Staged under the execution this request was just fenced as.
              staged: parsed.data.snapshot.snapshot_id
                ? {
                    snapshotId: parsed.data.snapshot.snapshot_id,
                    generation: parsed.data.generation,
                    fence: parsed.data.fence,
                    total: parsed.data.snapshot.total,
                    resume: parsed.data.snapshot.resume,
                    inspect: parsed.data.snapshot.inspect,
                  }
                : undefined,
            }
          : undefined,
        reason: parsed.data.reason,
      },
      { memberId: auth.memberId, apiKeyId: auth.apiKeyId },
    ));
    // Physical cache/graph/item cleanup is explicitly outside the execution-fence transaction.
    // Durable suppression + epoch already committed, so failure here is safe and retryable.
    const cleaned = await drainGdriveCleanupObligations(db, auth.teamId);
    return Response.json({ ...staged, ...cleaned });
  } catch (error) {
    if (error instanceof GdriveAuthorityError || error instanceof GdriveSnapshotError) {
      return errorResponse(error.code, error.message, error.status);
    }
    // Fixed messages from here on: an exception's own text can carry SQL, lock and relation detail.
    if (isLockTimeout(error)) {
      return errorResponse("temporarily_unavailable", "reconciliation is temporarily unavailable; retry shortly", 503);
    }
    console.error("[source-reconcile] failed:", error instanceof Error ? error.message : error);
    return errorResponse("internal", "reconciliation failed", 500);
  }
}
