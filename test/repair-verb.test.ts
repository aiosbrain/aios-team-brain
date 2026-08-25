import { describe, expect, it, vi } from "vitest";
import { runRepairSystemEdgeVerb, repairVerbDeps, type RepairVerbDeps } from "@/lib/access/repair-verb";
import type { DbClient } from "@/lib/db/types";

/** AUDITFIX-21 — the repair verb's pure layer, and its REAL dependency factory. */

function deps(over: Partial<RepairVerbDeps> = {}): RepairVerbDeps & { repair: ReturnType<typeof vi.fn> } {
  const repair = vi.fn(async () => ({ ok: true as const, revoked: true }));
  return {
    resolveGroup: async (s) => (s === "nope" ? null : { id: "gid", slug: s, is_builtin: false }),
    resolveProject: async (s) => (s === "nope" ? null : { id: "pid", kind: "system", slug: s }),
    resolveMemberIdByEmail: async (e) => (e === "admin@t.local" ? "mid" : null),
    repair,
    ...over,
  } as RepairVerbDeps & { repair: ReturnType<typeof vi.fn> };
}

describe("AUDITFIX-21: repair-system-edge", () => {
  it("AC14: reaches the writer once with the resolved ids", async () => {
    const d = deps();
    const r = await runRepairSystemEdgeVerb(d, { groupSlug: "vendors", projectSlug: "general", actorEmail: "admin@t.local" });
    expect(r).toEqual({ ok: true, revoked: true });
    expect(d.repair).toHaveBeenCalledTimes(1);
    expect(d.repair).toHaveBeenCalledWith("pid", "gid", "mid");
  });

  it("a destructive act must name its authorizer — no --actor, no writer call", async () => {
    const d = deps();
    const r = await runRepairSystemEdgeVerb(d, { groupSlug: "vendors", projectSlug: "general" });
    expect(r.ok).toBe(false);
    expect(d.repair).not.toHaveBeenCalled();
  });

  it("unresolvable names die before the writer", async () => {
    for (const args of [
      { groupSlug: "nope", projectSlug: "general", actorEmail: "admin@t.local" },
      { groupSlug: "vendors", projectSlug: "nope", actorEmail: "admin@t.local" },
      { groupSlug: "vendors", projectSlug: "general", actorEmail: "who@t.local" },
    ]) {
      const d = deps();
      const r = await runRepairSystemEdgeVerb(d, args);
      expect(r.ok).toBe(false);
      expect(d.repair).not.toHaveBeenCalled();
    }
  });

  it("the verb carries NO copy of the sanctioned decision — the writer owns it", async () => {
    // A sanctioned pair reaches the writer and is refused THERE. A preflight copy here is how the
    // two layers come to disagree, which is the defect this slice exists to repair.
    const d = deps({ repair: vi.fn(async () => ({ ok: false as const, error: "…SANCTIONED…" })) as RepairVerbDeps["repair"] });
    const r = await runRepairSystemEdgeVerb(d, { groupSlug: "everyone", projectSlug: "general", actorEmail: "admin@t.local" });
    expect(r.ok).toBe(false);
    expect((d as unknown as { repair: ReturnType<typeof vi.fn> }).repair).toHaveBeenCalledTimes(1);
  });

  it("AC15: the REAL factory selects the identity the writer needs, and surfaces read errors", async () => {
    // A type-correct `resolveGroup: async () => null` satisfies every criterion above while the
    // shipped command stays permanently broken — so the factory's actual queries are the assertion.
    const selects: Record<string, string> = {};
    const fake = {
      from(table: string) {
        const chain: Record<string, unknown> = {
          select(spec: string) { selects[table] = spec; return chain; },
          eq() { return chain; },
          async maybeSingle() {
            if (table === "groups") return { data: { id: "g1", slug: "vendors", is_builtin: false }, error: null };
            if (table === "projects") return { data: { id: "p1", kind: "system", slug: "general" }, error: null };
            return { data: { id: "m1" }, error: null };
          },
        };
        return chain;
      },
    } as unknown as DbClient;

    const d = repairVerbDeps(fake, "team", "cli");
    expect(await d.resolveGroup("vendors")).toEqual({ id: "g1", slug: "vendors", is_builtin: false });
    expect(await d.resolveProject("general")).toEqual({ id: "p1", kind: "system", slug: "general" });
    expect(await d.resolveMemberIdByEmail("a@t.local")).toBe("m1");
    expect(selects.groups, "the group's identity is slug AND is_builtin").toMatch(/is_builtin/);
    expect(selects.projects, "the project's identity is kind AND slug").toMatch(/kind/);
    expect(selects.projects).toMatch(/slug/);

    // And a read error must SURFACE — the existing revoke wiring swallows its error, which turns an
    // undetermined read into a confident "no such group".
    const erroring = {
      from() {
        const chain: Record<string, unknown> = {
          select() { return chain; }, eq() { return chain; },
          async maybeSingle() { return { data: null, error: { message: "boom" } }; },
        };
        return chain;
      },
    } as unknown as DbClient;
    await expect(repairVerbDeps(erroring, "team", "cli").resolveGroup("vendors")).rejects.toThrow(/group read failed/);
  });
});
