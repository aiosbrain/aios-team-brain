import "server-only";

import type { ApiAuth } from "@/lib/api/auth";
import type { DbClient } from "@/lib/db/types";
import { withTransaction } from "@/lib/db/pg/pool";
import { discoverMemberIdentity, type DiscoveredIdentityOutcome } from "@/lib/identity/member-identities";
import { resolveConfirmedEmail } from "@/lib/identity/provider-sync";
import { buildIdentityMap, providerIdentityState } from "@/lib/identity/resolve";
import {
  assertGdrivePayloadBinding,
  lockLiveGdriveExecution,
  type GdriveExecutionRef,
} from "@/lib/integrations/gdrive-authority";
import { normalizeGdriveContributions } from "@/lib/ingest/gdrive-contribution-store";

/**
 * AIO-1167 R44 F1 — the Drive ingest boundary turns an observed stable collaborator id into a
 * durable identity link, so credit follows the PERSON (`permission:<id>`) rather than a mutable email.
 *
 * Runs at the trusted, fenced boundary only: inside a transaction that first holds the caller's live
 * Drive execution (`lockLiveGdriveExecution`), BEFORE the push takes its attribution snapshot — so
 * that snapshot sees any link made here, and the identity revision it validates is the new one.
 *
 * Evidence rule: an observation carrying both a `permission:` id and an email, where that email
 * resolves to exactly one ACTIVE member through the linking map (`resolveConfirmedEmail`, which
 * refuses ambiguous and deactivated matches). The shared owner (`discoverMemberIdentity`) then
 * creates the link only if the id was never reviewed — an existing link, a manual mapping and an
 * unlink tombstone all stand, and a disagreeing email is recorded as a conflict, never a transfer.
 *
 * Payload binding first (AIO-1167 R45 L2): the evidence is admitted only from a payload bound to the
 * live connection (`assertGdrivePayloadBinding`, the same check the content commit makes). A payload
 * for another connection, or with no provider id, is refused here — before any identity read or
 * write — so a push the commit would reject cannot change the shared registry or trigger a repair.
 */
export async function discoverGdriveContributorIdentities(
  db: DbClient,
  auth: ApiAuth,
  ref: GdriveExecutionRef,
  frontmatter: Record<string, unknown>,
): Promise<Record<DiscoveredIdentityOutcome, number>> {
  assertGdrivePayloadBinding(frontmatter, ref);
  const outcomes: Record<DiscoveredIdentityOutcome, number> = {
    linked: 0, exists: 0, conflict: 0, reviewed: 0, ineligible: 0,
  };
  const candidates = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of normalizeGdriveContributions(frontmatter)) {
    if (!row.externalId?.startsWith("permission:") || !row.email) continue;
    const prior = candidates.get(row.externalId);
    // One id observed with two different emails in one push is not unambiguous evidence.
    if (prior && prior !== row.email) ambiguous.add(row.externalId);
    candidates.set(row.externalId, row.email);
  }
  for (const id of ambiguous) candidates.delete(id);
  if (candidates.size === 0) return outcomes;
  return withTransaction(async () => {
    await lockLiveGdriveExecution(auth, ref);
    const linking = await buildIdentityMap(db, auth.teamId, { strict: true });
    for (const [externalId, email] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
      // Already decided — linked, remapped or unlinked: nothing to discover (the owner re-checks).
      if (providerIdentityState(linking, "gdrive", externalId) !== null) {
        outcomes.reviewed++;
        continue;
      }
      const memberId = resolveConfirmedEmail(linking, email);
      if (!memberId) continue;
      outcomes[await discoverMemberIdentity(db, auth.teamId, memberId, {
        provider: "gdrive", externalId, email,
      }, { actor: { kind: "api_key", memberId: auth.memberId } })]++;
    }
    return outcomes;
  });
}
