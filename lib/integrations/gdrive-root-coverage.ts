/**
 * Selected-root coverage: the precondition of a COMPLETE Google Drive snapshot (AIO-1167 R41).
 *
 * A complete snapshot is a statement that every document of the connection's selection was seen;
 * applying it retires every claim not in it. That is only true when the stream roster is known — and
 * the roster is only known once every selected file/folder root has been bound to the drive whose
 * change stream contains it. A root whose drive could not be read (`unresolved`), whose location is
 * unreadable now (`uncertain`) or that is on its way to another drive (`relocating`) can hide a
 * stream nobody enumerated, so a "complete" snapshot is incomplete then by construction.
 *
 * The coordinator records one obligation per selected root in the brain-fenced connector state
 * (`progress.roots`, written only by the coordinator under the execution fence — see
 * `ingestion/aios_ingest/connector_state.py`). The absence boundary
 * (`withGdriveExecutionCommit(..., { requireRootCoverage })`) evaluates THIS function against the
 * LOCKED authority row before a complete snapshot may retire anything, so no caller — a current
 * sidecar with a bug, an older one, or anything else holding a connector key — can assert completion
 * past an unresolved root. Missing evidence is "unknown", never "resolved".
 *
 * Pure: no I/O, so it is unit-tested exhaustively.
 */

export type RootCoverageGap =
  | "root_evidence_missing"
  | "root_evidence_stale"
  | "root_unresolved"
  | "root_uncertain"
  | "root_relocating"
  | "root_unbound";

export type RootCoverage =
  | { complete: true }
  | { complete: false; gap: RootCoverageGap; root?: string };

interface RootItem {
  kind: string;
  id: string;
  status: string;
  drive_id: unknown;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function rootItems(section: Record<string, unknown>): RootItem[] {
  const items = section.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is RootItem =>
    !!item && typeof item === "object"
    && typeof (item as RootItem).kind === "string"
    && typeof (item as RootItem).id === "string"
    && typeof (item as RootItem).status === "string");
}

export function selectedRootCoverage(
  config: Record<string, unknown>,
  progress: Record<string, unknown> | null | undefined,
  generation: number,
): RootCoverage {
  // An intentionally empty selection, and Shared Drives selected outright, need no binding: their
  // streams are named by the selection itself.
  if (config.selectionState === "empty") return { complete: true };
  const selected = [
    ...stringIds(config.fileIds).map((id) => `file:${id}`),
    ...stringIds(config.folderIds).map((id) => `folder:${id}`),
  ];
  if (selected.length === 0) return { complete: true };

  const section = progress?.roots;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { complete: false, gap: "root_evidence_missing" };
  }
  const roots = section as Record<string, unknown>;
  if (Number(roots.generation) !== Number(generation)) {
    return { complete: false, gap: "root_evidence_stale" };
  }
  const items = rootItems(roots);
  // Any unsettled obligation — even one no longer selected in config — leaves the roster unknown.
  for (const item of items) {
    if (item.status === "unresolved") return { complete: false, gap: "root_unresolved", root: `${item.kind}:${item.id}` };
    if (item.status === "uncertain") return { complete: false, gap: "root_uncertain", root: `${item.kind}:${item.id}` };
    if (item.status === "relocating") return { complete: false, gap: "root_relocating", root: `${item.kind}:${item.id}` };
  }
  const bound = new Set(
    items
      .filter((item) => item.status === "bound" && typeof item.drive_id === "string" && item.drive_id.length > 0)
      .map((item) => `${item.kind}:${item.id}`),
  );
  const missing = selected.find((root) => !bound.has(root));
  return missing ? { complete: false, gap: "root_unbound", root: missing } : { complete: true };
}
