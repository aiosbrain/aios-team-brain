import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { linearAdapter } from "@/lib/pm-sync/linear";
import { planeAdapter } from "@/lib/pm-sync/plane";
import { resolvePrimaryProvider } from "@/lib/pm-sync/project";
import type { PmAdapter, PmProvider } from "@/lib/pm-sync/provider";

/**
 * Inbound divergence detection (brain-api v1.2 Phase 5).
 *
 * The brain is the source of truth and projects one-way into the primary PM tool. This pass closes
 * the observability loop the other direction: it reads the provider's CURRENT workflow state for
 * each projected item, records it on `task_pm_links.provider_seen_status`, and SURFACES any item
 * whose provider state has diverged from the brain's `last_projected_status`.
 *
 * Hard invariant — SURFACE-ONLY (brain wins):
 *   • never mutates the provider (no PATCH / no state write back to the board);
 *   • never changes brain `tasks.status` (or any task field);
 *   • the only write is `task_pm_links.provider_seen_status`, and only when it actually changed
 *     (so a second pass over an unchanged board performs ZERO writes — idempotent).
 *
 * Conflict policy is fixed at "brain wins": divergence is logged/surfaced on the PM-sync page for a
 * human to pull, never silently applied. Live provider reads use an injectable `fetchImpl` (tests
 * stub it; no live PM calls in CI).
 */

const ADAPTERS: Record<PmProvider, PmAdapter> = { plane: planeAdapter, linear: linearAdapter };

// The link columns reconcile reads. Named explicitly — the pg adapter (prod) rejects a bare "*".
const LINK_COLS = "id, row_key, provider, provider_resource_id, last_projected_status, provider_seen_status";

interface ReconcileLink {
  id: string;
  row_key: string;
  provider: PmProvider;
  provider_resource_id: string | null;
  last_projected_status: string | null;
  provider_seen_status: string | null;
}

export interface DivergenceRow {
  row_key: string;
  provider: PmProvider;
  last_projected_status: string | null;
  provider_seen_status: string | null;
}

export interface ReconcileResult {
  provider: PmProvider | null;
  // Count of links whose provider_seen_status was (re)written this pass — 0 on an idempotent re-run.
  seenUpdated: number;
  divergences: DivergenceRow[];
  reason?: string;
}

// Pure: a link is diverged when both sides are known and the provider's current state differs from
// what the brain last projected. Shared by the engine and the read-only PM-sync page render.
export function isDiverged(link: {
  last_projected_status: string | null;
  provider_seen_status: string | null;
}): boolean {
  return (
    !!link.provider_seen_status &&
    !!link.last_projected_status &&
    link.provider_seen_status !== link.last_projected_status
  );
}

export async function reconcileProviderState(
  supabase: SupabaseClient,
  teamId: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<ReconcileResult> {
  const primary = await resolvePrimaryProvider(supabase, teamId);
  if (primary.provider === null || primary.integration === null) {
    return { provider: primary.provider, seenUpdated: 0, divergences: [], reason: primary.reason };
  }
  const adapter = ADAPTERS[primary.provider];
  if (!adapter.fetchSeenStates) {
    return { provider: primary.provider, seenUpdated: 0, divergences: [], reason: `${primary.provider} has no inbound reconcile support` };
  }

  const { data } = await supabase
    .from("task_pm_links")
    .select(LINK_COLS)
    .eq("team_id", teamId)
    .eq("provider", primary.provider)
    .not("provider_resource_id", "is", null);
  const links = ((data ?? []) as ReconcileLink[]).filter((l) => l.provider_resource_id);
  if (!links.length) return { provider: primary.provider, seenUpdated: 0, divergences: [] };

  // One read of the provider's current states (resource id → state name). Read-only.
  const seenByResource = await adapter.fetchSeenStates({ integration: primary.integration, fetchImpl: opts.fetchImpl });

  let seenUpdated = 0;
  const divergences: DivergenceRow[] = [];
  for (const link of links) {
    const seen = seenByResource.get(link.provider_resource_id!) ?? null;
    if (seen === null) continue; // provider has no state for this item (e.g. deleted) — leave as-is

    // Persist the seen state ONLY when it changed — keeps a re-run write-free (idempotent).
    if (seen !== link.provider_seen_status) {
      await supabase
        .from("task_pm_links")
        .update({ provider_seen_status: seen, updated_at: new Date().toISOString() })
        .eq("id", link.id);
      seenUpdated += 1;
    }

    // Surface divergence from the brain's last projection — using the freshly-seen value.
    if (isDiverged({ last_projected_status: link.last_projected_status, provider_seen_status: seen })) {
      divergences.push({
        row_key: link.row_key,
        provider: link.provider,
        last_projected_status: link.last_projected_status,
        provider_seen_status: seen,
      });
    }
  }

  return { provider: primary.provider, seenUpdated, divergences };
}
