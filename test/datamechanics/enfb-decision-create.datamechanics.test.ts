import { describe, expect, it, vi } from "vitest";
import { db, seedTeam } from "./helpers";
import { rowVisibleByProvenance } from "@/lib/access/provenance";

// ENFB-1 AC7's write pin (diff-review Medium: the AC claimed a pin that did not exist): the
// dashboard create action WRITES `decisions.created_by` — the sole-writer fact the whole
// provenance rule rests on — and the created row survives the rule for team posture (the
// create→see round-trip), while staying invisible to external posture.

vi.mock("@/lib/auth/guard", () => ({
  currentMember: vi.fn(),
}));
vi.mock("@/lib/db/server", () => ({
  serverClient: vi.fn(),
}));

describe("ENFB-1 — createDecisionAction writes creation provenance", () => {
  it("created_by = the creating member; the row passes the provenance rule at team posture and fails it at external", async () => {
    const seed = await seedTeam();
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: "dc", name: "DC", kind: "initiative" }).select("id").single();
    // ENFB-2 H2: the create action now gates on row visibility — grant the creator the
    // fresh initiative the way createProjectAction's D1 grant would have.
    const { ensurePersonSingleton, grantProjectToGroup } = await import("@/lib/access/groups");
    const singleton = await ensurePersonSingleton(db(), seed.teamId, seed.memberId, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, (proj as { id: string }).id, singleton.groupId!, seed.memberId);

    const { currentMember } = await import("@/lib/auth/guard");
    const { serverClient } = await import("@/lib/db/server");
    (currentMember as ReturnType<typeof vi.fn>).mockResolvedValue({ id: seed.memberId, role: "admin", tier: "team" });
    (serverClient as ReturnType<typeof vi.fn>).mockResolvedValue(db());

    const { createDecisionAction } = await import("@/app/actions/decisions");
    const r = await createDecisionAction({
      teamId: seed.teamId,
      projectId: (proj as { id: string }).id,
      title: "Adopt the widget",
      rationale: "because",
      decidedBy: "Tester",
      impact: "medium",
      decidedAt: "2026-08-18",
    } as Parameters<typeof createDecisionAction>[0]);
    expect(r.ok, r.error).toBe(true);

    const { data: row } = await db()
      .from("decisions")
      .select("created_by, source_item_id")
      .eq("team_id", seed.teamId)
      .eq("title", "Adopt the widget")
      .single();
    expect((row as { created_by: string | null }).created_by, "the action is the provenance writer").toBe(seed.memberId);
    expect((row as { source_item_id: string | null }).source_item_id).toBeNull();

    // The round-trip: the row the action wrote passes the rule for team posture with ANY vis
    // set (null-source arm needs no items), and fails for external posture.
    expect(rowVisibleByProvenance(row as { source_item_id: string | null; created_by: string | null }, new Set(), "team")).toBe(true);
    expect(rowVisibleByProvenance(row as { source_item_id: string | null; created_by: string | null }, new Set(), "external")).toBe(false);
  });
});
