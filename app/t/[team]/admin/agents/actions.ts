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
 *
 * AUDITFIX-19: the request must carry an explicit `scope` choice — omission, the legacy
 * `projectScope` key and malformed choices are refused before anything is written. After the admin
 * gate, `validateMintRequest` captures and normalizes the whole request synchronously, BEFORE the
 * first visibility await; from then on only that normalized copy is used.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function mintAgentTokenAction(
  teamSlug: string,
  input: MintRequest
): Promise<MintResult> {
  // Authorization FIRST; team and admin identity come from the gate, never from the request.
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const policy = validateMintRequest(input, Date.now());
  if (!policy.ok) return { ok: false, error: policy.error };
  const request = policy.request;

  // SELECTED-PROJECTS MODE ONLY: the chosen list must be visible to BOTH the admin AND the launcher,
  // judged by the existing writer/destination predicate `visibleProjectRows` (the same one the
  // picker uses — not the membership read rule). Two different properties:
  //   · the ADMIN check is this mode's issuance policy — an admin cannot hand-pick a project they
  //     cannot themselves file into;
  //   · the LAUNCHER check is meaning — the token reads AS that member, so a project they cannot
  //     see would mint a scope that silently grants nothing (the oracle intersects live).
  // This is NOT a cap on every credential an admin can issue. An explicit all-reachable choice does
  // no enumeration: it stores NULL and reads whatever the LAUNCHER can see, live, including projects
  // the admin cannot — the same credential-management authority as issuing that member an API key
  // (docs/design/auditfix19-explicit-agent-scope.md). Fail-closed: a lookup error refuses the mint.
  // NOT race-free — visibility can change between this read and the insert, and the admin leg is
  // never rechecked on later token reads; the oracle re-derives the LAUNCHER's live visibility on
  // every request, which is the enforcement boundary.
  if (request.scope.kind === "projects") {
    const projectIds = request.scope.projectIds;
    const db = adminClient();
    const [adminVisible, launcherVisible] = await Promise.all([
      visibleProjectRows(db, { teamId: ctx.teamId, memberId: ctx.memberId }),
      visibleProjectRows(db, { teamId: ctx.teamId, memberId: request.memberId }),
    ]);
    if (adminVisible.error || launcherVisible.error) {
      return { ok: false, error: "could not verify project visibility for scope.projectIds — try again" };
    }
    if (projectIds.some((id) => !adminVisible.ids.has(id))) {
      return { ok: false, error: "scope.projectIds names project(s) you cannot see" };
    }
    if (projectIds.some((id) => !launcherVisible.ids.has(id))) {
      return { ok: false, error: "scope.projectIds names project(s) the launching member cannot see" };
    }
  }

  const result = await mintAgentToken(
    adminClient(),
    ctx.teamId,
    {
      memberId: request.memberId,
      // Refused by policy above; passed as null so the shape stays explicit at the writer.
      onBehalfOf: null,
      scope: request.scope,
      name: request.name,
      expiresAt: request.expiresAt,
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
