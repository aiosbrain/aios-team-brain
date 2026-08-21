import "server-only";
import { admitsUnsourced, type ProvenancePrincipal } from "@/lib/access/provenance-sql";

/**
 * The settled PROVENANCE rule for structured rows (tasks/decisions) on body-serving surfaces —
 * ONE owner (ENFB-1 §1; the timeline's PRET-5 H2 ruling generalized once `decisions.created_by`
 * exists):
 *   - a SOURCED row gates on its source item's membership visibility;
 *   - a NULL-SOURCE row survives only when HAND-TYPED (`created_by` — written solely by the
 *     dashboard create actions, never by sync, so a purged restricted basis stays dropped)
 *     AND the viewer is team posture (no membership axis exists for a hand-typed row, so the
 *     audience wall survives on exactly this branch).
 * Fail-closed: a missing visibility set denies sourced rows.
 *
 * `principal` (AUDITFIX-1) is the THIRD owner of this contract taking the same discriminator as the
 * two SQL forms, so "one contract, three owners" is true rather than asserted. The hand-typed arm is
 * admitted only for an explicit member at team posture; a token, an absent value and a foreign value
 * all close. It is REQUIRED rather than defaulted: a default would be the permissive value, and this
 * whole slice exists because a permissive default was obtainable by saying nothing.
 */
export function rowVisibleByProvenance(
  row: { source_item_id?: string | null; created_by?: string | null },
  visibleItemIds: ReadonlySet<string> | null,
  tier: "team" | "external",
  principal: ProvenancePrincipal
): boolean {
  const source = row.source_item_id ?? null;
  if (source !== null) return visibleItemIds != null && visibleItemIds.has(source);
  return (row.created_by ?? null) !== null && admitsUnsourced({ principal, teamPosture: tier === "team" });
}
