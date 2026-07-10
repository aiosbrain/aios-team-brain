import "server-only";
import type { DbClient } from "@/lib/db/types";
import {
  IngestValidationError,
  type SubscriptionPayload,
} from "@/lib/api/schemas";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";
import { audit } from "@/lib/api/audit";

/**
 * The ONLY write path for `subscriptions` (single-writer). Workstations push the
 * member's current flat plan from `aios analyze --push` (v1.8). Upsert on
 * (team, member, provider) — one current plan per member+provider.
 */
export async function ingestSubscription(
  db: DbClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: SubscriptionPayload,
): Promise<{ subscription_id: string; member_id: string }> {
  let memberId = auth.memberId;
  if (payload.member) {
    const map = await buildIdentityMap(db, auth.teamId);
    const resolved = resolveMember(map, { key: payload.member });
    if (!resolved)
      throw new IngestValidationError(
        `unknown member handle '${payload.member}'`,
      );
    memberId = resolved;
  }

  const { data, error } = await db
    .from("subscriptions")
    .upsert(
      {
        team_id: auth.teamId,
        member_id: memberId,
        provider: payload.provider,
        plan: payload.plan ?? "",
        monthly_usd: payload.monthly_usd,
        source: payload.source ?? "unknown",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_id,member_id,provider" },
    )
    .select("id")
    .single();
  if (error || !data)
    throw new Error(`subscription upsert failed: ${error?.message}`);

  await audit(db, {
    team_id: auth.teamId,
    actor_kind: "api_key",
    member_id: auth.memberId,
    api_key_id: auth.apiKeyId,
    action: "subscriptions.push",
    target_type: "member",
    target_id: memberId,
    meta: {
      provider: payload.provider,
      plan: payload.plan,
      monthly_usd: payload.monthly_usd,
    },
  });

  return { subscription_id: data.id, member_id: memberId };
}
