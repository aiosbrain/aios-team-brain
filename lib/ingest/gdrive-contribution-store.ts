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
import { gdriveObservationIdentity } from "@/lib/ingest/gdrive-ledger";

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
    // This key is only a stable idempotency identity (the full provider fields remain stored), not
    // a security boundary. An observation that carries a stable provider id is keyed by exactly
    // what makes it one observation in the frontmatter ledger — that id, the role and the instant
    // (`gdriveObservationIdentity`) — so a later replay that carries a new e-mail or spells the
    // same instant differently updates its row instead of adding a second one. Without a stable id
    // the key is unchanged, byte-for-byte the additive SQL backfill's. That backfill keys EVERY
    // row this legacy way, on first adoption only; `supersededEvidenceKeys` retires such a row
    // when its observation is next written.
    const identity = gdriveObservationIdentity(row);
    const evidenceKey = createHash("md5")
      .update(identity.stableId
        ? `${identity.person}\u001f${identity.role}\u001f${identity.at}`
        : `${externalId ?? ""}\u001f${email ?? ""}\u001f${role}\u001f${sourceAtRaw}`)
      .digest("hex");
    out.set(evidenceKey, {
      evidenceKey, externalId, email, displayName, role, sourceAt, sourceAtRaw, diagnostic,
    });
  }
  return [...out.values()];
}

export interface StoredGdriveEvidence {
  evidence_key: string;
  external_id: string | null;
  role: string;
  source_at: string | null;
  source_at_raw: string;
}

/**
 * Stored rows that ARE one of `current`'s observations — the same stable id, role and instant —
 * under another key: a row written before the e-mail or the timestamp spelling changed, or adopted
 * by the SQL backfill. The current write replaces each of them. A row whose observation is not
 * being written, and every row without a stable id, is left exactly as it is.
 */
export function supersededEvidenceKeys(
  stored: readonly StoredGdriveEvidence[],
  current: readonly NormalizedGdriveContribution[],
): string[] {
  const currentKeys = new Set(current.filter((row) => row.externalId).map((row) => row.evidenceKey));
  if (currentKeys.size === 0) return [];
  const superseded: string[] = [];
  for (const row of stored) {
    if (!row.external_id || currentKeys.has(row.evidence_key)) continue;
    const [asWrittenNow] = normalizeGdriveContributions({
      source: "gdrive",
      contributions: [{ external_id: row.external_id, role: row.role, at: row.source_at ?? row.source_at_raw }],
    });
    if (asWrittenNow && currentKeys.has(asWrittenNow.evidenceKey)) superseded.push(row.evidence_key);
  }
  return superseded;
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
  // One row per observation. Callers hold the item (item → versions → evidence), so the rows read
  // here cannot change before the writes below replace them.
  if (rows.some((row) => row.externalId)) {
    const stored = await db.from("gdrive_contribution_evidence")
      .select("evidence_key,external_id,role,source_at,source_at_raw")
      .eq("team_id", teamId).eq("item_id", itemId);
    if (stored.error) throw new Error(`gdrive contribution evidence read failed: ${stored.error.message}`);
    const superseded = supersededEvidenceKeys((stored.data ?? []) as StoredGdriveEvidence[], rows);
    if (superseded.length) {
      const { error } = await db.from("gdrive_contribution_evidence").delete()
        .eq("team_id", teamId).eq("item_id", itemId).in("evidence_key", superseded);
      if (error) throw new Error(`gdrive contribution evidence supersession failed: ${error.message}`);
    }
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
