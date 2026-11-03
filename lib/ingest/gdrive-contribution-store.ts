import "server-only";

import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import {
  buildIdentityMap,
  googleEmailBridge,
  providerIdentityState,
  resolveByProviderId,
  type IdentityMap,
} from "@/lib/identity/resolve";
import { runSql } from "@/lib/db/pg/pool";
import {
  gdriveObservationIdentity, gdriveObservedEmail, gdriveStableId, mergeGdriveContributions,
} from "@/lib/ingest/gdrive-ledger";

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
  // One row per observation, exactly as the frontmatter ledger keeps it: replays of one observation —
  // a legacy bare-email row and the producer's `author-email:` row among them (R52) — are one, and an
  // email-only observation proven to be a stable-id one is the same observation (R44 S4).
  const input = mergeGdriveContributions(frontmatter.contributions, []);
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
    // a security boundary. An observation that carries a provider key is keyed by that key, the role
    // and the instant (`gdriveObservationIdentity`) — so a later replay that carries a new e-mail or
    // spells the same instant differently updates its row instead of adding a second one. An
    // `author-email:` key keeps this keying (its stored rows stay addressable) although it is not a
    // stable id; an equivalent row stored under another key is retired by `supersededEvidenceKeys`. Without
    // a provider key the key is unchanged, byte-for-byte the additive SQL backfill's. That backfill keys EVERY
    // row this legacy way, on first adoption only; `supersededEvidenceKeys` retires such a row
    // when its observation is next written.
    const identity = gdriveObservationIdentity(row);
    const evidenceKey = createHash("md5")
      .update(externalId
        ? `id:${externalId}\u001f${identity.role}\u001f${identity.at}`
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
  /** Read for coalescing a legacy email-only row (R44 S4); absent in older callers' rows. */
  email?: string | null;
  role: string;
  source_at: string | null;
  source_at_raw: string;
}

/**
 * Stored rows that ARE one of `current`'s observations — the same provider key, role and instant —
 * under another key: a row written before the e-mail or the timestamp spelling changed, or adopted
 * by the SQL backfill. The current write replaces each of them. A row whose observation is not
 * being written, and every row without a provider key, is left exactly as it is — except an
 * email-only one (below).
 */
export function supersededEvidenceKeys(
  stored: readonly StoredGdriveEvidence[],
  current: readonly NormalizedGdriveContribution[],
): string[] {
  const currentKeys = new Set(current.filter((row) => row.externalId).map((row) => row.evidenceKey));
  if (currentKeys.size === 0) return [];
  // A stored EMAIL-ONLY row — no provider key, or an `author-email:` one, which names only the
  // address — is the same observation as exactly one current stable-id row naming that email at the
  // same role and instant (R44 S4, R51): it is replaced too, never counted twice.
  const stableByEmail = new Map<string, Set<string>>();
  for (const row of current) {
    const stableId = gdriveStableId(row.externalId);
    if (!stableId || !row.email) continue;
    const key = `${row.email}\u001f${row.role}\u001f${row.sourceAt ?? row.sourceAtRaw}`;
    stableByEmail.set(key, (stableByEmail.get(key) ?? new Set()).add(stableId));
  }
  // A stored email-only row is also the same observation as a current EMAIL-ONLY row naming that
  // email, role and instant under another key — a legacy bare-email row and the producer's
  // `author-email:` row (R52). That never folds into a stable id, so the ambiguity rule is untouched.
  const emailOnly = new Set<string>();
  for (const row of current) {
    const email = gdriveObservedEmail({ external_id: row.externalId, email: row.email });
    if (gdriveStableId(row.externalId) || !email) continue;
    emailOnly.add(`${email}\u001f${row.role}\u001f${row.sourceAt ?? row.sourceAtRaw}`);
  }
  const writtenKeys = new Set(current.map((row) => row.evidenceKey));
  const superseded: string[] = [];
  for (const row of stored) {
    if (writtenKeys.has(row.evidence_key)) continue;
    if (!gdriveStableId(row.external_id)) {
      const email = gdriveObservedEmail(row);
      const at = row.source_at ? new Date(row.source_at).toISOString() : row.source_at_raw;
      const observation = `${email}\u001f${row.role}\u001f${at}`;
      if (email && (stableByEmail.get(observation)?.size === 1 || emailOnly.has(observation))) {
        superseded.push(row.evidence_key);
        continue;
      }
      if (!row.external_id) continue;
    }
    const [asWrittenNow] = normalizeGdriveContributions({
      source: "gdrive",
      contributions: [{ external_id: row.external_id, role: row.role, at: row.source_at ?? row.source_at_raw }],
    });
    if (asWrittenNow && currentKeys.has(asWrittenNow.evidenceKey)) superseded.push(row.evidence_key);
  }
  return superseded;
}

function exactMember(
  identities: IdentityMap, row: NormalizedGdriveContribution,
): { memberId: string | null; emailConflict: boolean } {
  const byId = row.externalId ? resolveByProviderId(identities, "gdrive", row.externalId) : null;
  if (byId) return { memberId: byId, emailConflict: false };
  // A durable linked/unlinked authority row means this stable provider identity has been reviewed.
  // In particular, an explicit unlink must not be silently undone by the same row's email fallback.
  if (row.externalId && providerIdentityState(identities, "gdrive", row.externalId)) {
    return { memberId: null, emailConflict: false };
  }
  // The one Google email-bridge decision (R53): a held address bridges nowhere (PR743), and a linked
  // `author-email:` owner that disagrees with the confirmed owner credits neither.
  const bridge = googleEmailBridge(identities, row.email);
  return {
    memberId: bridge.outcome === "member" ? bridge.memberId : null,
    emailConflict: bridge.outcome === "conflict",
  };
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
  const map = identities ?? await buildIdentityMap(db, teamId, { strict: true, includeDeactivated: true });
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
      .select("evidence_key,external_id,email,role,source_at,source_at_raw")
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
    const { memberId: sourceMemberId, emailConflict } = exactMember(map, row);
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
      diagnostic: row.diagnostic ?? correctionDiagnostic
        ?? (memberId ? null : emailConflict ? "google_email_conflict" : "unresolved_identity"),
      updated_at: new Date().toISOString(),
    }, { onConflict: "team_id,item_id,evidence_key" });
    if (error) throw new Error(`gdrive contribution evidence write failed: ${error.message}`);
  }
  return { observed: rows.length, resolved, diagnostics };
}
