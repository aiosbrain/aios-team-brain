const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export interface GdriveObservationIdentity {
  /** The provider's stable id for the person (`permission:<id>`), when the observation carries one. */
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
  const stableId = text(row.external_id) || null;
  const email = text(row.email).toLowerCase();
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
 * so no provenance is lost. Rows are otherwise returned unchanged, in order.
 */
export function coalesceGdriveObservations<T extends object>(rows: readonly T[]): T[] {
  const stableByEmail = new Map<string, Set<string>>();
  const fields = (row: T) => row as Record<string, unknown>;
  const emailKey = (row: Record<string, unknown>) => {
    const email = text(row.email).toLowerCase();
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
    byObservation.set(`${person}\0${role}\0${at}`, row);
  }
  return coalesceGdriveObservations([...byObservation.values()]);
}
