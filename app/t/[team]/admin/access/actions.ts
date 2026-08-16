"use server";

import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { backfillTeamContext } from "@/lib/projects/context/backfill";

/**
 * Admin trigger for the §11 context backfill (spec §11.2). On-demand counterpart to the
 * scheduler convergence leg: an admin runs it to partition this team's existing content
 * immediately rather than waiting for the tick. Drains the cursor to completion (bounded batch
 * loop, same MAX guard as the all-teams driver). Idempotent. Admin-gated.
 */
export async function runContextBackfillAction(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; unitsCreated?: number; membershipsCreated?: number; batches?: number }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const cutoff = new Date().toISOString();
  let cursor: string | null = null;
  let unitsCreated = 0;
  let membershipsCreated = 0;
  const MAX_BATCHES = 10_000;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const r = await backfillTeamContext(adminClient(), ctx.teamId, { afterId: cursor, createdBefore: cutoff });
    if (!r.ok) return { ok: false, error: r.error, unitsCreated, membershipsCreated, batches: batch };
    unitsCreated += r.unitsCreated;
    membershipsCreated += r.membershipsCreated;
    if (r.cursor === null) return { ok: true, unitsCreated, membershipsCreated, batches: batch + 1 };
    cursor = r.cursor;
  }
  return { ok: false, error: `guard exhausted at cursor ${cursor} — corpus not fully backfilled`, unitsCreated, membershipsCreated, batches: MAX_BATCHES };
}
