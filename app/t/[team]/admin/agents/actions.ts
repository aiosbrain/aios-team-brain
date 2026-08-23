"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { mintAgentToken, revokeAgentToken, type MintResult } from "@/lib/access/agent-tokens";
import { validateMintRequest, type MintRequest } from "@/lib/access/agent-token-policy";
import { visibleProjectRows } from "@/lib/access/enforce";

/**
 * Cache revalidation must never be able to discard an already-minted credential. `revalidatePath`
 * runs AFTER the row is written, and the secret is returned exactly once — so if it throws, the
 * caller sees a failure while a live token exists that nobody can ever read. A stale list is a
 * cosmetic problem; an orphaned credential is a security one. Narrow by construction: it wraps only
 * this one call, and only on the success path.
 */
function revalidateAgents(teamSlug: string): void {
  try {
    revalidatePath(`/t/${teamSlug}/admin/agents`);
  } catch {
    // Outside a request context (direct invocation in tests) or a revalidation fault — neither is a
    // reason to lose the token the caller is about to be shown.
  }
}

/**
 * Admin mint/revoke for delegated agent tokens (spec §10 QM slice — "mint/revoke admin
 * actions before any UI"). Thin admin-gated wrappers over the lib/access/agent-tokens single
 * writer. The returned token string appears exactly once, here — it is never stored, logged, or
 * retrievable again.
 *
 * AGENTUI-1: request policy moved OUT of this file into `lib/access/agent-token-policy`, and is
 * applied here so it binds every caller. These are server actions — public HTTP endpoints — so a
 * rule enforced only by the mint form binds only the people who use the form. The policy module is
 * separate because a `"use server"` file may export nothing but async functions, and the form and
 * this action have to share one lifetime cap.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function mintAgentTokenAction(
  teamSlug: string,
  input: MintRequest
): Promise<MintResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const policy = validateMintRequest(input, Date.now());
  if (!policy.ok) return { ok: false, error: policy.error };

  // SCOPE ⊆ WHAT THE ADMIN CAN SEE. The picker only offers visible projects, but the picker is a
  // web page and this is a public endpoint — the property has to hold here or it is not a property.
  // (Fable diff review: the claim was stated at the boundary and enforced only in the UX, which is
  // the exact shape this whole slice exists to repudiate.) Fail-closed: a substrate error yields an
  // empty visible set, so a scoped mint is refused rather than waved through.
  if (input.projectScope != null) {
    const visible = await visibleProjectRows(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId });
    const unseen = input.projectScope.filter((id) => !visible.ids.has(id));
    if (unseen.length > 0) {
      return { ok: false, error: "projectScope names project(s) you cannot see" };
    }
  }

  const result = await mintAgentToken(
    adminClient(),
    ctx.teamId,
    {
      memberId: input.memberId,
      // Refused by policy above; passed as null so the shape stays explicit at the writer.
      onBehalfOf: null,
      projectScope: input.projectScope ?? null,
      name: input.name?.slice(0, 200),
      expiresAt: input.expiresAt ?? null,
    },
    ctx.memberId
  );
  // The list is server-rendered; without this it still shows the pre-mint state.
  if (result.ok) revalidateAgents(teamSlug);
  return result;
}

export async function revokeAgentTokenAction(
  teamSlug: string,
  tokenRowId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!UUID_RE.test(tokenRowId)) return { ok: false, error: "tokenRowId must be a uuid" };
  const result = await revokeAgentToken(adminClient(), ctx.teamId, tokenRowId, ctx.memberId);
  if (result.ok) revalidateAgents(teamSlug);
  return result;
}
