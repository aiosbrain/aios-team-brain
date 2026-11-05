import { googleEmailKey } from "@/lib/identity/google-email-authority";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * The observation's stable provider id, or `null`. `author-email:<address>` is NOT one: Drive's
 * producer writes it when it withholds a permission id, so it names the address only — the same
 * evidence an email-only observation carries (AIO-1167 R51). Every other provider key (`permission:`)
 * is.
 */
export function gdriveStableId(externalId: unknown): string | null {
  const id = text(externalId);
  return id && !googleEmailKey("gdrive", id) ? id : null;
}

/** The address an observation names: its `email`, else the one its `author-email:` key carries. */
export function gdriveObservedEmail(row: { external_id?: unknown; email?: unknown }): string {
  const email = text(row.email).toLowerCase();
  if (email) return email;
  const key = googleEmailKey("gdrive", text(row.external_id));
  return key ? key.slice("author-email:".length) : "";
}

export interface GdriveObservationIdentity {
  /** The provider's stable id for the person (`permission:<id>`), when the observation carries one;
   *  never an `author-email:` key (`gdriveStableId`). */
  stableId: string | null;
  person: string;
  role: string;
  /** The observed instant in UTC; the source text unchanged when it is not a readable time. */
  at: string;
}

/**
 * Who, in which role, at which instant — the identity of one source observation. A stable provider
 * id IS the person whatever e-mail or display name accompanies it, and an instant is the same
 * instant however the provider spelled it. The frontmatter ledger (`mergeGdriveContributions`) and
 * the evidence store (`normalizeGdriveContributions`) both key on this one definition, so a replay
 * that changes only that metadata is the same observation in both.
 */
export function gdriveObservationIdentity(row: Record<string, unknown>): GdriveObservationIdentity {
  const stableId = gdriveStableId(row.external_id);
  // The address an email-only observation names. A legacy bare-email row `{email: E}` and the
  // producer's `{external_id: "author-email:E", email: E}` both name only E, so at the same role and
  // instant they are ONE observation (AIO-1167 R52); neither is a stable id.
  const email = gdriveObservedEmail(row);
  const displayName = text(row.display_name);
  const person = stableId
    ? `id:${stableId}`
    : email
      ? `email:${email}`
      : displayName
        ? `display:${displayName}`
        : "unknown";
  const raw = typeof row.at === "string" ? row.at.trim() : String(row.at ?? "");
  const parsed = typeof row.at === "string" ? new Date(raw) : null;
  const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : raw;
  return { stableId, person, role: text(row.role).toLowerCase(), at };
}

/**
 * Fold an email-only observation into the ONE stable-id observation that proves it is the same
 * person, role and instant (AIO-1167 R44 S4).
 *
 * Drive reports a collaborator by permission id when it has one and by email otherwise, so one edit
 * replayed after the id became available arrives twice: `email:E` and `id:permission:P` carrying
 * email `E`, same role, same instant. The explicit evidence for coalescing them is that observation
 * itself — the stable-id row names the same email at the same role and instant. Only an UNAMBIGUOUS
 * match coalesces: exactly one stable id carrying that email there. Sharing an AIOS member is never
 * evidence (one person may hold several accounts). The stable-id row is kept; it carries the email,
 * so no provenance is lost. An `author-email:E` observation is email-only here (`gdriveStableId`): it
 * folds the same way, and never stands as a stable id beside `permission:P`. Rows are otherwise
 * returned unchanged, in order.
 */
export function coalesceGdriveObservations<T extends object>(rows: readonly T[]): T[] {
  const stableByEmail = new Map<string, Set<string>>();
  const fields = (row: T) => row as Record<string, unknown>;
  const emailKey = (row: Record<string, unknown>) => {
    const email = gdriveObservedEmail(row);
    if (!email) return null;
    const { role, at } = gdriveObservationIdentity(row);
    return `${email}\0${role}\0${at}`;
  };
  for (const row of rows) {
    const { stableId } = gdriveObservationIdentity(fields(row));
    const key = stableId ? emailKey(fields(row)) : null;
    if (!stableId || !key) continue;
    const ids = stableByEmail.get(key) ?? new Set<string>();
    ids.add(stableId);
    stableByEmail.set(key, ids);
  }
  return rows.filter((row) => {
    if (gdriveObservationIdentity(fields(row)).stableId) return true;
    const key = emailKey(fields(row));
    return !key || stableByEmail.get(key)?.size !== 1;
  });
}

/** A stored Drive evidence row, as far as observation identity is concerned. */
export interface StoredGdriveEvidenceRow {
  item_id: string;
  external_id: string | null;
  email: string | null;
  role: string;
  source_at: string;
}

/**
 * Stored evidence rows with each item's email-only duplicates folded into the one stable-id row that
 * names the same email, role and instant (AIO-1167 R44 S4) — the ledger's own coalescing rule, applied
 * per item, so the Timeline counts that observation once whatever state the ledger was stored in.
 * Rows are otherwise returned unchanged, in order.
 */
export function coalesceStoredGdriveEvidence<T extends StoredGdriveEvidenceRow>(rows: readonly T[]): T[] {
  const byItem = new Map<string, T[]>();
  for (const row of rows) byItem.set(row.item_id, [...(byItem.get(row.item_id) ?? []), row]);
  const kept = new Set<T>();
  for (const itemRows of byItem.values()) {
    const views = itemRows.map((row) => ({ external_id: row.external_id, email: row.email, role: row.role, at: row.source_at, row }));
    for (const view of coalesceGdriveObservations(views)) kept.add(view.row);
  }
  return rows.filter((row) => kept.has(row));
}

/**
 * One stored evidence row per item observation, as the Timeline reads them: email-only rows folded
 * into their one stable-id row (`coalesceStoredGdriveEvidence`), then, per item, one row per stable id
 * or address with its role and instant. A legacy bare-email row and the producer's `author-email:`
 * row of one email, role and instant are one observation (R52), and — as in `mergeGdriveContributions`
 * — the row carrying the provider key speaks for it whatever the order or write times: it keeps the
 * exact `author-email:` mapping authority, which a bare row would trade for a roster-email guess.
 * Between rows of the same provenance the most recently written one speaks. A row naming neither
 * stays keyed by its own evidence key.
 */
export function latestStoredGdriveObservations<
  T extends StoredGdriveEvidenceRow & { evidence_key: string; updated_at: string },
>(rows: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of coalesceStoredGdriveEvidence(rows)) {
    const { person, role, at } = gdriveObservationIdentity({
      external_id: row.external_id, email: row.email, role: row.role, at: row.source_at,
    });
    const key = row.external_id || row.email
      ? `${row.item_id}\0${person}\0${role}\0${at}`
      : `${row.item_id}\0${row.evidence_key}`;
    const seen = latest.get(key);
    const keyed = Boolean(text(row.external_id));
    const seenKeyed = Boolean(seen && text(seen.external_id));
    if (!seen || (keyed && !seenKeyed)
      || (keyed === seenKeyed && Date.parse(row.updated_at) > Date.parse(seen.updated_at))) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

/** Preserve each source-observed person/role/instant and deduplicate exact replays. */
export function mergeGdriveContributions(
  stored: unknown,
  incoming: unknown,
): Array<Record<string, unknown>> {
  const rows = [
    ...(Array.isArray(stored) ? stored : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ].filter(record);
  const byObservation = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const { person, role, at } = gdriveObservationIdentity(row);
    const key = `${person}\0${role}\0${at}`;
    // A replay of one observation replaces it — except that a legacy bare-email row never replaces
    // the producer's `author-email:` row for the same observation, in either order (R52).
    const seen = byObservation.get(key);
    if (seen && text(seen.external_id) && !text(row.external_id)) continue;
    byObservation.set(key, row);
  }
  return coalesceGdriveObservations([...byObservation.values()]);
}
