import "server-only";

import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import {
  buildIdentityMap,
  providerIdentityState,
  resolveByProviderId,
  type IdentityMap,
} from "@/lib/identity/resolve";
import { runSql } from "@/lib/db/pg/pool";

type RawContribution = Record<string, unknown>;

export interface NormalizedGdriveContribution {
  evidenceKey: string;
  externalId: string | null;
  email: string | null;
  displayName: string | null;
  role: string;
  sourceAt: string | null;
  sourceAtRaw: string;
  diagnostic: string | null;
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** Normalize retained provider observations without guessing identity or time. Invalid observations
 * remain durable and diagnosable, but cannot become Timeline evidence until repaired at the source. */
export function normalizeGdriveContributions(frontmatter: Record<string, unknown>): NormalizedGdriveContribution[] {
  if (text(frontmatter.source).toLowerCase() !== "gdrive") return [];
  const input = Array.isArray(frontmatter.contributions)
    ? frontmatter.contributions.filter((r): r is RawContribution => Boolean(r) && typeof r === "object" && !Array.isArray(r))
    : [];
  const out = new Map<string, NormalizedGdriveContribution>();
  for (const row of input) {
    const externalId = text(row.external_id) || null;
    const email = text(row.email).toLowerCase() || null;
    const displayName = text(row.display_name) || null;
    const role = text(row.role).toLowerCase();
    const sourceAtRaw = text(row.at);
    if (!role) continue;
    const parsed = new Date(sourceAtRaw);
    const sourceAt = sourceAtRaw && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    const diagnostic = !externalId && !email
      ? "missing_identity"
      : !sourceAt
        ? "missing_source_time"
        : null;
    // Keep this byte-for-byte identical to the additive SQL backfill. This key is only a stable
    // idempotency identity (the full provider fields remain stored), not a security boundary.
    const evidenceKey = createHash("md5")
      .update(`${externalId ?? ""}\u001f${email ?? ""}\u001f${role}\u001f${sourceAtRaw}`)
      .digest("hex");
    out.set(evidenceKey, {
      evidenceKey, externalId, email, displayName, role, sourceAt, sourceAtRaw, diagnostic,
    });
  }
  return [...out.values()];
}

function exactMember(identities: IdentityMap, row: NormalizedGdriveContribution): string | null {
  const byId = row.externalId ? resolveByProviderId(identities, "gdrive", row.externalId) : null;
  if (byId) return byId;
  // A durable linked/unlinked authority row means this stable provider identity has been reviewed.
  // In particular, an explicit unlink must not be silently undone by the same row's email fallback.
  if (row.externalId && providerIdentityState(identities, "gdrive", row.externalId)) return null;
  if (!row.email || identities.ambiguousEmails?.has(row.email)) return null;
  return identities.byEmail.get(row.email) ?? null;
}

export async function syncGdriveContributionEvidence(
  db: DbClient,
  teamId: string,
  itemId: string,
  frontmatter: Record<string, unknown>,
  identities?: IdentityMap,
  correction: {
    memberIdLocked?: boolean | null;
    memberId?: string | null;
    authorityRevision?: number;
  } = {},
): Promise<{ observed: number; resolved: number; diagnostics: number }> {
  const rows = normalizeGdriveContributions(frontmatter);
  if (text(frontmatter.source).toLowerCase() !== "gdrive") return { observed: 0, resolved: 0, diagnostics: 0 };
  // Strict reads are part of the mutation transaction. If any identity owner is unavailable, throw;
  // the surrounding ingest/repair transaction rolls back rather than publishing partial credit.
  const map = identities ?? await buildIdentityMap(db, teamId, { strict: true });
  const externalIds = [...new Set(rows.flatMap((r) => r.externalId ? [r.externalId] : []))];
  const revisions = new Map<string, number>();
  if (externalIds.length) {
    const { rows: states } = await runSql<{ external_id: string; revision: string | number }>(
      `select external_id,revision from member_identity_mapping_state
        where team_id=$1 and provider='gdrive' and external_id=any($2::text[])`,
      [teamId, externalIds],
    );
    for (const state of states) revisions.set(state.external_id, Number(state.revision));
  }
  let resolved = 0;
  let diagnostics = 0;
  for (const row of rows) {
    const sourceMemberId = exactMember(map, row);
    const memberId = correction.memberIdLocked ? correction.memberId ?? null : sourceMemberId;
    if (memberId) resolved++;
    const correctionDiagnostic = correction.memberIdLocked
      ? correction.memberId ? "manual_attribution" : "manual_credit_nobody"
      : null;
    if (row.diagnostic || correctionDiagnostic || !memberId) diagnostics++;
    const { error } = await db.from("gdrive_contribution_evidence").upsert({
      team_id: teamId,
      item_id: itemId,
      evidence_key: row.evidenceKey,
      external_id: row.externalId,
      email: row.email,
      display_name: row.displayName,
      role: row.role,
      source_at: row.sourceAt,
      source_at_raw: row.sourceAtRaw,
      member_id: memberId,
      mapping_revision: correction.memberIdLocked
        ? null
        : row.externalId ? revisions.get(row.externalId) ?? null : null,
      authority_revision: correction.authorityRevision ?? null,
      diagnostic: row.diagnostic ?? correctionDiagnostic ?? (memberId ? null : "unresolved_identity"),
      updated_at: new Date().toISOString(),
    }, { onConflict: "team_id,item_id,evidence_key" });
    if (error) throw new Error(`gdrive contribution evidence write failed: ${error.message}`);
  }
  return { observed: rows.length, resolved, diagnostics };
}
