import "server-only";
import type { DbClient } from "@/lib/db/types";
import { IngestValidationError, type MaturitySnapshotPayload } from "@/lib/api/schemas";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";
import { audit } from "@/lib/api/audit";
import { placement, type AemPlacement } from "@/lib/metrics/individual-maturity";

/**
 * The ONLY write path for `agentic_maturity_snapshots` (single-writer). The client
 * (`aios analyze`) posts raw SIGNALS + a provisional placement; the canonical
 * axis/Spine scores are recomputed HERE (lib/metrics/maturity.placement) so there
 * is one scoring authority for team rollups. Idempotent on
 * (team_id, member_id, snapshot_date, metric). Separated from the read helpers in
 * maturity.ts so the maturity-tier-filter guard only polices reads.
 */
export async function ingestMaturitySnapshot(
  supabase: DbClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: MaturitySnapshotPayload
): Promise<{ snapshot_id: string; member_id: string; canonical: AemPlacement }> {
  // Resolve the member: an explicit handle must map to a team member; else self.
  let memberId = auth.memberId;
  if (payload.member) {
    const map = await buildIdentityMap(supabase, auth.teamId);
    const resolved = resolveMember(map, { key: payload.member });
    if (!resolved) throw new IngestValidationError(`unknown member handle '${payload.member}'`);
    memberId = resolved;
  }

  const s = payload.signals;
  const canonical = placement(s);

  const { data, error } = await supabase
    .from("agentic_maturity_snapshots")
    .upsert(
      {
        team_id: auth.teamId,
        member_id: memberId,
        snapshot_date: payload.date,
        metric: payload.metric,
        window_days: payload.window_days,
        delegation_ratio: s.delegation_ratio,
        correction_loop_avg: s.correction_loop_avg,
        error_rate: s.error_rate,
        cost_per_task: s.cost_per_task,
        tokens_per_task: s.tokens_per_task,
        cache_hit_rate: s.cache_hit_rate,
        tool_diversity: s.tool_diversity,
        verify_tool_rate: s.verify_tool_rate,
        subagent_usage: s.subagent_usage,
        total_cost_usd: s.total_cost_usd ?? 0,
        input_tokens: s.input_tokens ?? 0,
        output_tokens: s.output_tokens ?? 0,
        cache_read_tokens: s.cache_read_tokens ?? 0,
        sessions: payload.sessions,
        tasks: payload.tasks,
        provisional_spine: payload.provisional.spine,
        provisional_axes: JSON.stringify(payload.provisional.axes), // jsonb (postgres-only cast)
        canonical_spine: canonical.spine,
        canonical_verification: canonical.axes.verification,
        canonical_context_hygiene: canonical.axes.context_hygiene,
        canonical_autonomy: canonical.axes.autonomy,
        canonical_learning: canonical.axes.learning,
        canonical_cost_governance: canonical.axes.cost_governance,
        canonical_overall: canonical.overall,
        // Omitted (older client) → key absent, column untouched on conflict (preserves a
        // previously stored band). Explicit null → column set to NULL, clearing it.
        ...(payload.ce_band !== undefined ? { ce_band: payload.ce_band } : {}),
      },
      { onConflict: "team_id,member_id,snapshot_date,metric" }
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`maturity snapshot upsert failed: ${error?.message}`);

  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "api_key",
    member_id: auth.memberId,
    api_key_id: auth.apiKeyId,
    action: "maturity.snapshot",
    target_type: "member",
    target_id: memberId,
    meta: {
      date: payload.date,
      spine: canonical.spine,
      overall: canonical.overall,
      tasks: payload.tasks,
      // Preserve the omitted-vs-explicit-null distinction in the audit trail too — collapsing
      // them (e.g. via `?? null`) would hide whether a re-push actually cleared a stored band.
      ce_band: payload.ce_band === undefined ? "unchanged" : payload.ce_band,
    },
  });

  return { snapshot_id: data.id, member_id: memberId, canonical };
}
