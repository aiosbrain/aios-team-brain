const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
    const identity =
      typeof row.external_id === "string" && row.external_id
        ? `id:${row.external_id}`
        : typeof row.email === "string" && row.email
          ? `email:${row.email.toLowerCase()}`
          : typeof row.display_name === "string" && row.display_name
            ? `display:${row.display_name}`
            : "unknown";
    const role = typeof row.role === "string" ? row.role.toLowerCase() : "";
    const parsed = typeof row.at === "string" ? new Date(row.at) : null;
    const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : String(row.at ?? "");
    byObservation.set(`${identity}\0${role}\0${at}`, row);
  }
  return [...byObservation.values()];
}
