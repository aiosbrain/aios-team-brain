import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";

/**
 * The ownership-transition event stream: **`item.reassigned`**. One uniform, per-item, timestamped audit
 * event emitted whenever an item's owner changes from one real member to a different target — whatever the
 * cause. `via` classifies WHY, which is exactly the handoff-vs-mislabel distinction a future windowed-credit
 * consumer needs (see docs/design/attribution-ownership-timeline.md):
 *   • `author_signal`  — a SOURCE reassignment (the frontmatter author/assignee moved, e.g. Linear/Plane).
 *                        Leans HANDOFF: the outgoing owner may have real tenure → `from_owned_since` set.
 *   • `pusher_default` — a collaborative pusher-takeover (a different key re-pushed with no author signal).
 *   • `correction`     — an admin mislabel-fix (`applyAttributionCorrection` + the `member_id_locked` flag):
 *                        authoritative "the outgoing owner was NEVER really it", so the window is VOID and
 *                        no `from_owned_since` is recorded.
 * Best-effort like `audit()` — a transition-log write never takes the ingest/correction path down.
 */

export type ReassignmentVia = "author_signal" | "pusher_default" | "correction";

export interface ReassignmentActor {
  kind: "member" | "api_key" | "system";
  memberId: string | null;
  apiKeyId?: string | null;
}

function reassignMeta(
  from: string,
  to: string | null,
  source: string | null,
  via: ReassignmentVia,
  fromOwnedSince: string | null
): Record<string, unknown> {
  const m: Record<string, unknown> = { from, to, source, via };
  if (fromOwnedSince) m.from_owned_since = fromOwnedSince; // only for source transitions (handoff tenure)
  return m;
}

/**
 * When the OUTGOING owner's window began — the most recent prior ownership-establishing audit event for
 * this item (`item.created` / `item.reassigned` / `item.attribution_healed`, whichever last set the
 * current owner). Enables the handoff-tenure + short-tenure-mislabel heuristic without an external join.
 * Best-effort: a non-audited `member_id` change (e.g. the reattribute batch) would make this conservative;
 * null when no such event exists. `items` has no `created_at`, so the `item.created` audit is the anchor.
 */
export async function ownerWindowStart(db: DbClient, teamId: string, itemId: string): Promise<string | null> {
  const { data } = await db
    .from("audit_log")
    .select("created_at")
    .eq("team_id", teamId)
    .eq("target_id", itemId)
    .in("action", ["item.created", "item.reassigned", "item.attribution_healed"])
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as { created_at: string } | undefined)?.created_at ?? null;
}

/** Record ONE ownership transition (a source reassignment or a pusher-takeover, from the ingest paths). */
export async function recordReassignment(
  db: DbClient,
  entry: {
    teamId: string;
    itemId: string;
    from: string;
    to: string | null;
    source: string | null;
    via: ReassignmentVia;
    actor: ReassignmentActor;
    fromOwnedSince: string | null;
  }
): Promise<void> {
  await audit(db, {
    team_id: entry.teamId,
    actor_kind: entry.actor.kind,
    member_id: entry.actor.memberId,
    api_key_id: entry.actor.apiKeyId ?? null,
    action: "item.reassigned",
    target_type: "items",
    target_id: entry.itemId,
    meta: reassignMeta(entry.from, entry.to, entry.source, entry.via, entry.fromOwnedSince),
  });
}

/**
 * Record MANY correction-driven reassignments in ONE append. A bulk admin correction can touch up to the
 * match cap, so we batch-insert rather than loop `audit()` (append-only, best-effort). `via: "correction"`
 * = an authoritative mislabel-fix → no `from_owned_since` (the outgoing owner's window is void). The caller
 * passes ONLY items whose owner genuinely changed (a real prior owner ≠ the target).
 */
export async function recordCorrectionReassignments(
  db: DbClient,
  teamId: string,
  actorMemberId: string,
  changes: { itemId: string; from: string; to: string | null }[]
): Promise<void> {
  if (changes.length === 0) return;
  const rows = changes.map((c) => ({
    team_id: teamId,
    actor_kind: "member" as const,
    member_id: actorMemberId,
    api_key_id: null as string | null,
    action: "item.reassigned",
    target_type: "items",
    target_id: c.itemId,
    meta: reassignMeta(c.from, c.to, null, "correction", null),
    ip: null as string | null,
  }));
  try {
    await db.from("audit_log").insert(rows);
  } catch {
    // best-effort — mirrors audit(); a transition-log miss must never fail the correction.
  }
}
