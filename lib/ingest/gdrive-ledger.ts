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
  return [...byObservation.values()];
}
