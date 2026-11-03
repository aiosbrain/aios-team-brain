import "server-only";

import type { ApiAuth } from "@/lib/api/auth";
import { audit } from "@/lib/api/audit";
import type { DbClient } from "@/lib/db/types";
import { withTransaction } from "@/lib/db/pg/pool";
import { discoverMemberIdentity, type DiscoveredIdentityOutcome } from "@/lib/identity/member-identities";
import { buildIdentityMap, googleEmailBridge, providerIdentityState } from "@/lib/identity/resolve";
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
 * bridges to exactly one ACTIVE member through the linking map — the one Google email-bridge decision
 * (`googleEmailBridge`, AIO-1167 R53), which refuses ambiguous and deactivated matches, a held address,
 * and an address whose deliberately linked `author-email:` owner disagrees with its confirmed
 * roster/alias owner (refused for BOTH and audited as a discovery conflict). The shared owner
 * (`discoverMemberIdentity`) then
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
      // The ONLY evidence for a never-reviewed permission id is this email. If the email's own Google
      // identity was deliberately unlinked, or its equivalent histories are ambiguous, that decision
      // stands: the held email cannot mint a new stable mapping (AIO-1167 final review A2). Decided on
      // the map read above, under the identity authority this transaction already holds, so a
      // concurrent unlink is either seen here or serialized after this link. Roster email for other
      // providers is untouched, and an independently established permission mapping (above) keeps
      // its authority.
      const bridge = googleEmailBridge(linking, email);
      if (bridge.outcome === "held") {
        outcomes.reviewed++;
        continue;
      }
      if (bridge.outcome === "conflict") {
        // The address's `author-email:` identity is deliberately linked to one member while its confirmed
        // roster/alias owner is another (or the address is ambiguous, or the linked owner is not
        // eligible): the email cannot say whose permission id this is (AIO-1167 R53). No link to either
        // member; the refusal is audited on the existing Google discovery-conflict path for the Admin
        // diagnostic — the candidate the email names, beside the `author-email:` owner holding it.
        await audit(db, {
          team_id: auth.teamId, actor_kind: "api_key", member_id: auth.memberId,
          action: "identity.discovery_conflict", target_type: "member", target_id: bridge.emailMemberId,
          meta: {
            provider: "gdrive", external_id: externalId, mapped_member_id: bridge.linkedMemberId,
            reason: "author_email_owner",
          },
        });
        outcomes.conflict++;
        continue;
      }
      if (bridge.outcome !== "member") continue;
      const memberId = bridge.memberId;
      outcomes[await discoverMemberIdentity(db, auth.teamId, memberId, {
        provider: "gdrive", externalId, email,
      }, { actor: { kind: "api_key", memberId: auth.memberId } })]++;
    }
    return outcomes;
  });
}
