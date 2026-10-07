import { NextRequest } from "next/server";
import { z } from "zod";

import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/schemas";
import { rateLimit } from "@/lib/api/rate-limit";
import {
  drainGdriveCleanupObligations,
  GDRIVE_SNAPSHOT_PAGE_LIMIT,
  GdriveSnapshotError,
  stageGdriveReconciliation,
} from "@/lib/ingest/source-reconcile";
import { GdriveAuthorityError, withGdriveExecutionCommit } from "@/lib/integrations/gdrive-authority";

export const runtime = "nodejs";

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
  }).refine(
    (snapshot) => (snapshot.snapshot_id !== undefined && snapshot.complete) === (snapshot.total !== undefined),
    { message: "snapshot.total is stated on, and only on, the completing page of a staged snapshot" },
  ).optional(),
  reason: z.string().trim().min(1).max(500),
}).strict();

/** Provider-confirmed removal and complete-snapshot reconciliation for connector workers. */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:source-reconcile:post`, 30))) {
    return errorResponse("rate_limited", "30 reconciliations/min per key", 429);
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
    return errorResponse("internal", error instanceof Error ? error.message : "reconciliation failed", 500);
  }
}
