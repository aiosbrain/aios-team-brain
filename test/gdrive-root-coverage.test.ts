import { describe, expect, it } from "vitest";
import { selectedRootCoverage } from "@/lib/integrations/gdrive-root-coverage";

/**
 * AIO-1167 R41 — the precondition of a complete Drive snapshot, as the absence boundary evaluates it.
 *
 * Spec. A complete snapshot retires every claim it omits, so it may be applied only when every
 * selected file/folder root has POSITIVE, settled evidence for this generation in the coordinator's
 * fenced `progress.roots`: missing, stale, unresolved, uncertain, relocating or unbound evidence all
 * refuse. Selections that need no binding (empty, or Shared Drives only) are always covered.
 */
const config = { fileIds: ["F"], folderIds: ["D"], sharedDriveIds: ["S"], selectionState: "selected" };
const bound = (kind: string, id: string, drive = "my-drive") => ({ kind, id, status: "bound", drive_id: drive });
const evidence = (items: unknown[], generation = 7) => ({ roots: { generation, items } });

describe("selectedRootCoverage", () => {
  it("is complete when every selected root is bound for this generation", () => {
    expect(selectedRootCoverage(config, evidence([bound("file", "F"), bound("folder", "D", "shared-x")]), 7))
      .toEqual({ complete: true });
  });

  it("needs no evidence for an empty selection or Shared Drives selected outright", () => {
    expect(selectedRootCoverage({ ...config, selectionState: "empty" }, {}, 7)).toEqual({ complete: true });
    expect(selectedRootCoverage({ fileIds: [], folderIds: [], sharedDriveIds: ["S"] }, {}, 7)).toEqual({ complete: true });
  });

  it.each([
    ["no evidence at all", {}, "root_evidence_missing"],
    ["a malformed section", { roots: ["nope"] }, "root_evidence_missing"],
    ["evidence of another generation", evidence([bound("file", "F"), bound("folder", "D")], 6), "root_evidence_stale"],
    ["an unresolved root", evidence([bound("file", "F"), { kind: "folder", id: "D", status: "unresolved", drive_id: null }]), "root_unresolved"],
    ["an uncertain root", evidence([bound("file", "F"), { ...bound("folder", "D"), status: "uncertain" }]), "root_uncertain"],
    ["a relocating root", evidence([bound("file", "F"), { ...bound("folder", "D"), status: "relocating" }]), "root_relocating"],
    ["a selected root with no obligation", evidence([bound("file", "F")]), "root_unbound"],
    ["a bound root without a drive", evidence([bound("file", "F"), { kind: "folder", id: "D", status: "bound", drive_id: "" }]), "root_unbound"],
    ["an obligation in an unknown state", evidence([bound("file", "F"), { kind: "folder", id: "D", status: "weird", drive_id: "x" }]), "root_unbound"],
  ])("refuses %s", (_label, progress, gap) => {
    const coverage = selectedRootCoverage(config, progress as Record<string, unknown>, 7);
    expect(coverage).toMatchObject({ complete: false, gap });
  });

  it("an unsettled obligation for a root no longer in the config still refuses", () => {
    const progress = evidence([
      bound("file", "F"), bound("folder", "D"), { kind: "file", id: "old", status: "unresolved", drive_id: null },
    ]);
    expect(selectedRootCoverage(config, progress, 7)).toMatchObject({ complete: false, gap: "root_unresolved", root: "file:old" });
  });

  it("evidence for a file root does not cover a folder root of the same id", () => {
    expect(selectedRootCoverage({ fileIds: [], folderIds: ["X"] }, evidence([bound("file", "X")]), 7))
      .toMatchObject({ complete: false, gap: "root_unbound", root: "folder:X" });
  });
});
