import "server-only";
import type { DbClient } from "@/lib/db/types";
import { IngestValidationError, type UsageCostPayload } from "@/lib/api/schemas";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";
import { audit } from "@/lib/api/audit";

/**
 * The ONLY write path for `usage_costs` (single-writer). Workstations push daily
 * aggregates from `aios analyze --push` — Cursor dashboard USD + Claude session estimates.
 */
export async function ingestUsageCost(
  supabase: DbClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: UsageCostPayload
): Promise<{ cost_id: string; member_id: string }> {
  let memberId = auth.memberId;
  if (payload.member) {
    const map = await buildIdentityMap(supabase, auth.teamId);
    const resolved = resolveMember(map, { key: payload.member });
    if (!resolved) throw new IngestValidationError(`unknown member handle '${payload.member}'`);
    memberId = resolved;
  }

  const { data, error } = await supabase
    .from("usage_costs")
    .upsert(
      {
        team_id: auth.teamId,
        member_id: memberId,
        cost_date: payload.date,
        provider: payload.provider,
        source: payload.source,
        project: payload.project ?? "",
        input_tokens: payload.input_tokens ?? 0,
        output_tokens: payload.output_tokens ?? 0,
        cache_read_tokens: payload.cache_read_tokens ?? 0,
        cost_usd: payload.cost_usd,
        events: payload.events ?? 0,
        meta: payload.meta ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,member_id,cost_date,provider,source,project" }
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`usage cost upsert failed: ${error?.message}`);

  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "api_key",
    member_id: auth.memberId,
    api_key_id: auth.apiKeyId,
    action: "costs.push",
    target_type: "member",
    target_id: memberId,
    meta: {
      date: payload.date,
      provider: payload.provider,
      cost_usd: payload.cost_usd,
      project: payload.project,
    },
  });

  return { cost_id: data.id, member_id: memberId };
}
