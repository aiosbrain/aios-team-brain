export interface GdriveStoredItem {
  id: string;
  frontmatter: Record<string, unknown> | null;
}

/** Pure absence/removal decision; incomplete snapshots can never delete by omission. */
export function gdriveRemovalCandidates(
  rows: GdriveStoredItem[],
  removedProviderIds: Iterable<string>,
  snapshot?: { complete: boolean; providerIds: Iterable<string> },
): string[] {
  const explicit = new Set([...removedProviderIds].map((id) => id.trim()).filter(Boolean));
  const selected = new Set([...(snapshot?.providerIds ?? [])].map((id) => id.trim()).filter(Boolean));
  const snapshotApplied = snapshot?.complete === true;
  const doomed: string[] = [];
  for (const row of rows) {
    const providerId = typeof row.frontmatter?.source_id === "string" ? row.frontmatter.source_id : "";
    if (!providerId) continue;
    if (explicit.has(providerId) || (snapshotApplied && !selected.has(providerId))) doomed.push(row.id);
  }
  return doomed;
}
