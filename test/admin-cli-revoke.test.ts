import { describe, expect, it, vi } from "vitest";
import { runRevokeProjectVerb, REVOKE_USAGE, type RevokeVerbDeps } from "@/lib/access/revoke-verb";

// REVOKE-1 AC3: the CLI verb's pure decision layer — every refusal arm dies BEFORE the writer
// (pinned with a spying writer), and the system-kind preflight names the substrate. The real
// invariants live in the writer (dm-pinned); this layer sequences resolution and messages.

function deps(over: Partial<RevokeVerbDeps> = {}): RevokeVerbDeps & { revoke: ReturnType<typeof vi.fn> } {
  const revoke = vi.fn(async () => ({ ok: true as const, revoked: true }));
  return {
    resolveGroupId: async (slug) => (slug === "g" ? "gid" : null),
    resolveProject: async (slug) =>
      slug === "p" ? { id: "pid", kind: "initiative" } : slug === "general" ? { id: "sysid", kind: "system" } : null,
    resolveMemberIdByEmail: async (email) => (email === "admin@t.local" ? "mid" : null),
    revoke,
    ...over,
  };
}

describe("REVOKE-1 — the revoke-project verb's decision layer", () => {
  it("refuses without --actor BEFORE any resolution or writer call (a destructive act may not be attributed to nobody)", async () => {
    const d = deps();
    const r = await runRevokeProjectVerb(d, { groupSlug: "g", projectSlug: "p" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--actor <admin-email> is required/);
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it("missing slugs → usage, writer untouched", async () => {
    const d = deps();
    const r = await runRevokeProjectVerb(d, { actorEmail: "admin@t.local" });
    expect(r).toEqual({ ok: false, error: REVOKE_USAGE });
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it("unknown group / project / email each die with a distinct message, writer untouched", async () => {
    const d = deps();
    const g = await runRevokeProjectVerb(d, { groupSlug: "nope", projectSlug: "p", actorEmail: "admin@t.local" });
    const p = await runRevokeProjectVerb(d, { groupSlug: "g", projectSlug: "nope", actorEmail: "admin@t.local" });
    const e = await runRevokeProjectVerb(d, { groupSlug: "g", projectSlug: "p", actorEmail: "nobody@t.local" });
    expect(g).toEqual({ ok: false, error: "no group 'nope' on this team" });
    expect(p).toEqual({ ok: false, error: "no project 'nope' on this team" });
    expect(e).toEqual({ ok: false, error: "no member 'nobody@t.local' on this team" });
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it("the system-kind preflight names the substrate and never reaches the writer", async () => {
    const d = deps();
    const r = await runRevokeProjectVerb(d, { groupSlug: "g", projectSlug: "general", actorEmail: "admin@t.local" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/SYSTEM project.*access substrate/);
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it("the happy path calls the writer exactly once with the resolved ids and surfaces revoked", async () => {
    const d = deps();
    const r = await runRevokeProjectVerb(d, { groupSlug: "g", projectSlug: "p", actorEmail: "admin@t.local" });
    expect(r).toEqual({ ok: true, revoked: true });
    expect(d.revoke).toHaveBeenCalledTimes(1);
    expect(d.revoke).toHaveBeenCalledWith("pid", "gid", "mid");
  });

  it("a writer refusal surfaces verbatim; a no-op surfaces revoked:false", async () => {
    const refused = deps({ revoke: vi.fn(async () => ({ ok: false as const, error: "revoke principal rejected: x" })) });
    const r1 = await runRevokeProjectVerb(refused, { groupSlug: "g", projectSlug: "p", actorEmail: "admin@t.local" });
    expect(r1).toEqual({ ok: false, error: "revoke principal rejected: x" });
    const noop = deps({ revoke: vi.fn(async () => ({ ok: true as const, revoked: false })) });
    const r2 = await runRevokeProjectVerb(noop, { groupSlug: "g", projectSlug: "p", actorEmail: "admin@t.local" });
    expect(r2).toEqual({ ok: true, revoked: false });
  });
});
