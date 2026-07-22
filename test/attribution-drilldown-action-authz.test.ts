import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Spec: the drill-down server actions are globally-invokable HTTP endpoints — the import-location guard
 * on `lib/attribution/health` does NOT gate them (it only checks *where* the read is imported). So each
 * action must enforce admin ITSELF via `requireTeamAdmin`, and a non-admin caller must be denied BEFORE
 * any DB read. This mocks the guard to a non-admin and asserts denial without touching Postgres.
 */

const { requireTeamAdmin, getMemberItems, previewCorrection } = vi.hoisted(() => ({
  requireTeamAdmin: vi.fn(),
  getMemberItems: vi.fn(),
  previewCorrection: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin }));
vi.mock("@/lib/attribution/health", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMemberItems }));
vi.mock("@/lib/attribution/correction", async (orig) => ({ ...(await orig<Record<string, unknown>>()), previewCorrection }));
// The action module pulls in server-only write/LLM deps we don't exercise here — stub them out.
vi.mock("@/lib/ingest/attribution-correction", () => ({ applyAttributionCorrection: vi.fn() }));
vi.mock("@/lib/ingest/reconcile-attribution", () => ({ bustTeamArcs: vi.fn() }));
vi.mock("@/lib/db/admin", () => ({ adminClient: vi.fn() }));
vi.mock("@/lib/query/answering", () => ({ resolveAnsweringKeys: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { getMemberItemsAction, previewCorrectionPlanAction } from "@/app/t/[team]/admin/attribution/actions";

describe("drill-down actions — admin gate is the real authz (no RLS backstop)", () => {
  beforeEach(() => {
    requireTeamAdmin.mockReset();
    getMemberItems.mockReset();
    previewCorrection.mockReset();
  });

  it("getMemberItemsAction denies a non-admin and never reads the DB", async () => {
    requireTeamAdmin.mockResolvedValue(null); // not an admin
    const res = await getMemberItemsAction("acme", "550e8400-e29b-41d4-a716-446655440000");
    expect(res).toEqual({ ok: false, error: "admins only" });
    expect(getMemberItems).not.toHaveBeenCalled();
  });

  it("previewCorrectionPlanAction denies a non-admin and never resolves a correction", async () => {
    requireTeamAdmin.mockResolvedValue(null);
    const res = await previewCorrectionPlanAction("acme", { kind: "reassign", match: { itemId: "550e8400-e29b-41d4-a716-446655440000" }, toMember: "Fatma" });
    expect(res).toEqual({ ok: false, error: "admins only" });
    expect(previewCorrection).not.toHaveBeenCalled();
  });

  it("getMemberItemsAction rejects a malformed memberId for an admin (zod-validated) before the read", async () => {
    requireTeamAdmin.mockResolvedValue({ teamId: "t1", memberId: "admin" });
    const res = await getMemberItemsAction("acme", "not-a-uuid");
    expect(res).toEqual({ ok: false, error: "invalid request" });
    expect(getMemberItems).not.toHaveBeenCalled();
  });
});
