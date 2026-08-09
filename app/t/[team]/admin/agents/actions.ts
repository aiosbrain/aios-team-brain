"use server";

import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { mintAgentToken, revokeAgentToken, type MintResult } from "@/lib/access/agent-tokens";

/**
 * Admin mint/revoke for delegated agent tokens (spec §10 QM slice — "mint/revoke admin
 * actions before any UI"). Thin admin-gated wrappers over the lib/access/agent-tokens single
 * writer; the §15.7 launcher screen builds on these later. The returned token string appears
 * exactly once, here — it is never stored, logged, or retrievable again.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function mintAgentTokenAction(
  teamSlug: string,
  input: {
    memberId: string;
    onBehalfOf?: string | null;
    /** null/undefined = unattenuated (spawn default); [] = sees nothing. */
    projectScope?: string[] | null;
    name?: string;
    expiresAt?: string | null;
  }
): Promise<MintResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!UUID_RE.test(input.memberId)) return { ok: false, error: "memberId must be a member uuid" };
  if (input.onBehalfOf != null && !UUID_RE.test(input.onBehalfOf)) {
    return { ok: false, error: "onBehalfOf must be a member uuid" };
  }
  if (input.projectScope != null && input.projectScope.some((p) => !UUID_RE.test(p))) {
    return { ok: false, error: "projectScope must contain project uuids" };
  }
  if (input.expiresAt != null && Number.isNaN(Date.parse(input.expiresAt))) {
    return { ok: false, error: "expiresAt must be an ISO timestamp" };
  }
  return mintAgentToken(
    adminClient(),
    ctx.teamId,
    {
      memberId: input.memberId,
      onBehalfOf: input.onBehalfOf ?? null,
      projectScope: input.projectScope ?? null,
      name: input.name?.slice(0, 200),
      expiresAt: input.expiresAt ?? null,
    },
    ctx.memberId
  );
}

export async function revokeAgentTokenAction(
  teamSlug: string,
  tokenRowId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!UUID_RE.test(tokenRowId)) return { ok: false, error: "tokenRowId must be a uuid" };
  return revokeAgentToken(adminClient(), ctx.teamId, tokenRowId, ctx.memberId);
}
