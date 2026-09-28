import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  role: null as null | "admin" | "lead" | "member",
  memberTeam: "team-a",
  originUnavailable: false,
  originRead: vi.fn(),
  write: vi.fn(),
  currentMember: vi.fn(),
}));
vi.mock("@/lib/decisions/service", () => ({ createDashboardDecision: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ currentMember: fixture.currentMember }));
vi.mock("@/lib/db/server", () => ({
  serverClient: async () => ({
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
        async maybeSingle() {
          if (table === "decisions") return { data: { team_id: "team-a" }, error: null };
          if (table !== "governed_item_origins") throw new Error(`Unexpected table ${table}`);
          fixture.originRead(Object.fromEntries(filters));
          return { data: filters.get("entity_id") === "governed-id" ? { item_id: "source-id" } : null,
            error: fixture.originUnavailable ? { message: "unavailable" } : null };
        },
        update(value: unknown) {
          return { eq: async (key: string, id: string) => {
            fixture.write(table, value, key, id);
            return { error: null };
          } };
        },
      };
      return query;
    },
  }),
}));
import { setDecisionValidityAction } from "@/app/actions/decisions";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.role = null;
  fixture.memberTeam = "team-a";
  fixture.originUnavailable = false;
  fixture.currentMember.mockImplementation(async (teamId: string) =>
    fixture.role && teamId === fixture.memberTeam ? { id: "member-id", role: fixture.role, tier: "team" } : null);
});

describe("decision validity authorization before origin classification", () => {
  it.each([
    { caller: "unauthenticated", role: null, team: "team-a" },
    { caller: "ordinary member", role: "member", team: "team-a" },
    { caller: "admin from another team", role: "admin", team: "team-b" },
  ] as const)("gives $caller the same refusal for governed and ordinary records without probing origin", async ({ role, team }) => {
    fixture.role = role;
    fixture.memberTeam = team;
    const governed = await setDecisionValidityAction("governed-id", false);
    const ordinary = await setDecisionValidityAction("ordinary-id", false);
    expect(governed).toEqual({ ok: false, error: "admins and leads only" });
    expect(ordinary).toEqual(governed);
    expect(fixture.currentMember).toHaveBeenNthCalledWith(1, "team-a");
    expect(fixture.currentMember).toHaveBeenNthCalledWith(2, "team-a");
    expect(fixture.originRead).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each(["admin", "lead"] as const)("retains the immutable refusal for an authorized %s", async role => {
    fixture.role = role;
    expect(await setDecisionValidityAction("governed-id", false)).toEqual({
      ok: false, error: "This governed record is immutable; refresh the read-only mirror.",
    });
    expect(fixture.currentMember.mock.invocationCallOrder[0]).toBeLessThan(fixture.originRead.mock.invocationCallOrder[0]);
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("retains ordinary validity updates for an authorized lead", async () => {
    fixture.role = "lead";
    expect(await setDecisionValidityAction("ordinary-id", false)).toEqual({ ok: true });
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith("decisions", { still_valid: false, updated_at: expect.any(String) }, "id", "ordinary-id");
  });

  it("fails closed on origin lookup error after authorization", async () => {
    fixture.role = "admin";
    fixture.originUnavailable = true;
    expect(await setDecisionValidityAction("ordinary-id", false)).toEqual({ ok: false, error: "decision authority unavailable" });
    expect(fixture.write).not.toHaveBeenCalled();
  });
});
