import "server-only";
import { unsourcedAdmission, assertNeverAdmission, type ProvenancePrincipal } from "@/lib/access/provenance-sql";

/**
 * The settled PROVENANCE rule for structured rows (tasks/decisions) on body-serving surfaces —
 * ONE owner (ENFB-1 §1; the timeline's PRET-5 H2 ruling generalized once `decisions.created_by`
 * exists):
 *   - a SOURCED row gates on its source item's membership visibility;
 *   - a NULL-SOURCE row survives only when HAND-TYPED (`created_by` — written solely by the
 *     dashboard create actions, never by sync, so a purged restricted basis stays dropped)
 *     AND EITHER the viewer is a member at team posture, OR the viewer is a TOKEN whose effective
 *     project set contains the row's `project_id` (AUDITFIX-7 — the claim that a hand-typed row
 *     "cannot be tested against a token's scope" was false; it carries a project).
 * Fail-closed: a missing visibility set denies sourced rows.
 *
 * `principal` (AUDITFIX-1) is the THIRD owner of this contract taking the same discriminator as the
 * two SQL forms, so "one contract, three owners" is true rather than asserted. The hand-typed arm is
 * admitted only for an explicit member at team posture; a token, an absent value and a foreign value
 * all close. It is REQUIRED rather than defaulted: a default would be the permissive value, and this
 * whole slice exists because a permissive default was obtainable by saying nothing.
 */
export interface ProvenanceRow {
  source_item_id?: string | null;
  created_by?: string | null;
  /** Required on the TOKEN path — see the overloads below. */
  project_id?: string | null;
}

/**
 * ⚠️ THE TOKEN OVERLOAD REQUIRES `project_id: string` STATICALLY (AUDITFIX-7, spec round 2 HIGH 2).
 *
 * `tasks.project_id` and `decisions.project_id` are NOT NULL in the schema, so a materialised row
 * that lacks the field means THE CALLER DID NOT SELECT IT — never that the record has no project.
 * Denying quietly in that case is correct for access and wrong for everything else: it turns a
 * one-line wiring defect into an apparently legitimate empty result, which nobody diagnoses. Two
 * production callers omit the column today and are member-only; a future token reuse must not
 * compile rather than silently drop rows.
 *
 * So: a token call whose row type cannot promise `project_id` is a TYPE ERROR, and a row that
 * nonetheless arrives without one at runtime is denied AND logged.
 */
export function rowVisibleByProvenance(
  row: ProvenanceRow & { project_id: string },
  visibleItemIds: ReadonlySet<string> | null,
  tier: "team" | "external",
  principal: "token",
  tokenProjectIds: readonly string[]
): boolean;
export function rowVisibleByProvenance(
  row: ProvenanceRow,
  visibleItemIds: ReadonlySet<string> | null,
  tier: "team" | "external",
  principal: Exclude<ProvenancePrincipal, "token">
): boolean;
export function rowVisibleByProvenance(
  row: ProvenanceRow,
  visibleItemIds: ReadonlySet<string> | null,
  tier: "team" | "external",
  principal: ProvenancePrincipal,
  tokenProjectIds?: readonly string[]
): boolean {
  const source = row.source_item_id ?? null;
  if (source !== null) return visibleItemIds != null && visibleItemIds.has(source);
  if ((row.created_by ?? null) === null) return false;

  const admission = unsourcedAdmission({ principal, teamPosture: tier === "team", tokenProjectIds });
  switch (admission.kind) {
    case "closed":
      return false;
    case "all":
      return true;
    case "projects": {
      const projectId = row.project_id ?? null;
      if (projectId === null) {
        // Denied, but NOT silently: the column is NOT NULL, so this is a caller that forgot to
        // select it. The overloads make it a compile error; this is the runtime backstop.
        console.error(
          "[access] rowVisibleByProvenance: token admission with no project_id on the row — the caller did not select it; denying"
        );
        return false;
      }
      return admission.projectIds.includes(projectId);
    }
    default:
      return assertNeverAdmission(admission);
  }
}
