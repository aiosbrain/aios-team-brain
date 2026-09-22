import { describe, expect, it } from "vitest";
import { gdriveRemovalCandidates } from "@/lib/ingest/gdrive-reconcile";

const rows = [
  { id: "item-a", frontmatter: { source_id: "DocA" } },
  { id: "item-b", frontmatter: { source_id: "doc-b" } },
  { id: "legacy-unknown", frontmatter: {} },
];

describe("AIO-1167 Google Drive lifecycle evidence", () => {
  it("AC-05: applies positive tombstones using exact case-sensitive provider ids", () => {
    expect(gdriveRemovalCandidates(rows, ["DocA"], undefined)).toEqual(["item-a"]);
    expect(gdriveRemovalCandidates(rows, ["doca"], undefined)).toEqual([]);
  });

  it("AC-05/06: never treats an incomplete snapshot as deletion evidence", () => {
    expect(gdriveRemovalCandidates(rows, [], { complete: false, providerIds: [] })).toEqual([]);
  });

  it("AC-05/06: reconciles absence only from a complete authorized snapshot", () => {
    expect(gdriveRemovalCandidates(rows, [], { complete: true, providerIds: ["DocA"] }))
      .toEqual(["item-b"]);
  });
});
