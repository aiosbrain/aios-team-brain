import { describe, expect, it } from "vitest";
import { authorize } from "@/lib/policy";
import { createPolicy, setPolicyEnabled, deletePolicy, listAllPolicies } from "@/lib/policy/manage";
import { db, seedTeam } from "./helpers";

// Spec: a policy authored in the admin UI (via lib/policy/manage) actually GOVERNS the engine's
// authorize() decision — the whole point of the Policies editor. Verified on real Postgres.

const principal = { role: "member" as const, tier: "team" as const, actor: "alex" };
const req = { principal, action: "code.run", resource: "*" };

describe("policy manage → authorize (real Postgres)", () => {
  it("a UI-created policy governs authorize(); priority + toggle + delete all reflect", async () => {
    const seed = await seedTeam();

    // Default-deny with no rules.
    expect((await authorize(db(), seed.teamId, req)).effect).toBe("deny");

    // Create an allow → now allowed.
    const allowId = await createPolicy(db(), seed.teamId, { action: "code.run", effect: "allow", priority: 1 });
    expect((await authorize(db(), seed.teamId, req)).effect).toBe("allow");

    // A higher-priority require_approval wins.
    await createPolicy(db(), seed.teamId, { action: "code.*", effect: "require_approval", priority: 5 });
    expect((await authorize(db(), seed.teamId, req)).effect).toBe("require_approval");

    // Disabling the allow: listAllPolicies still shows it (editor needs disabled), authorize ignores it.
    await setPolicyEnabled(db(), seed.teamId, allowId, false);
    expect((await listAllPolicies(db(), seed.teamId)).find((p) => p.id === allowId)?.enabled).toBe(false);

    // Delete the require_approval rule → only the (disabled) allow remains → back to default deny.
    const ra = (await listAllPolicies(db(), seed.teamId)).find((p) => p.effect === "require_approval")!;
    await deletePolicy(db(), seed.teamId, ra.id);
    expect((await authorize(db(), seed.teamId, req)).effect).toBe("deny");
  });

  it("validates effect + requires an action", async () => {
    const seed = await seedTeam();
    await expect(createPolicy(db(), seed.teamId, { action: "", effect: "allow" })).rejects.toThrow(/action is required/);
    await expect(createPolicy(db(), seed.teamId, { action: "x", effect: "bogus" as never })).rejects.toThrow(/invalid effect/);
  });
});
