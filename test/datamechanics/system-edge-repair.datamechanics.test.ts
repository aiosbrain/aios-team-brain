import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, type Seed } from "./helpers";
import type { DbClient } from "@/lib/db/types";
import {
  EXTERNAL_SLUG,
  EVERYONE_SLUG,
  createGroup,
  revokeProjectFromGroup,
  revokeUnsanctionedSystemEdge,
} from "@/lib/access/groups";
import { ensureAccessBootstrap, EXTERNAL_SHARED_SLUG, GENERAL_SLUG } from "@/lib/access/bootstrap";

/**
 * AUDITFIX-21 — spec `docs/design/auditfix21-system-edge-repair.md`.
 *
 * The REPAIR: delete exactly one forbidden edge on a protected project, and nothing else, ever.
 *
 * ⚠️ The dangerous direction here is DELETION. Losing `general→everyone` blinds every member of the
 * team until bootstrap re-grants it. Read §4 before touching a criterion: across this lane seventeen
 * mutations were found aimed at criteria that could not tell them from a correct implementation.
 */

async function team(): Promise<Seed> {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok, "fixture: bootstrap converges").toBe(true);
  return seed;
}

async function admin(seed: Seed, over: Partial<{ role: string; status: string; tier: string }> = {}): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "A",
      actor_handle: `a-${randomUUID().slice(0, 10)}`,
      role: over.role ?? "admin",
      tier: over.tier ?? "team",
      status: over.status ?? "active",
    })
    .select("id")
    .single();
  expect(error, "fixture admin must insert").toBeNull();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, over.tier === "external" ? "external" : "team");
  return data!.id as string;
}

async function projectId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", slug).single();
  return (data as { id: string }).id;
}

async function builtinId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", slug).eq("is_builtin", true).single();
  return (data as { id: string }).id;
}

async function ordinaryGroup(seed: Seed, slug: string, actor: string): Promise<string> {
  const g = await createGroup(db(), seed.teamId, slug, slug, actor);
  expect(g.ok, `fixture group '${slug}': ${g.error}`).toBe(true);
  return g.groupId as string;
}

/** A reserved-slug project at a chosen kind — `source` and `initiative` are only reachable directly. */
async function projectAtKind(seed: Seed, slug: string, kind: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug, kind })
    .select("id")
    .single();
  expect(error, `fixture ${kind} project '${slug}' must insert`).toBeNull();
  return (data as { id: string }).id;
}

async function plant(seed: Seed, p: string, g: string): Promise<void> {
  const { error } = await db().from("project_groups").insert({ team_id: seed.teamId, project_id: p, group_id: g, added_by: null });
  expect(error, "fixture edge must be planted").toBeNull();
}

async function edgeExists(seed: Seed, p: string, g: string): Promise<boolean> {
  const { data } = await db().from("project_groups").select("project_id").eq("team_id", seed.teamId).eq("project_id", p).eq("group_id", g).maybeSingle();
  return data !== null;
}

async function revokedAudits(seed: Seed): Promise<number> {
  const { data } = await db().from("audit_log").select("id").eq("team_id", seed.teamId).eq("action", "access.project_revoked");
  return ((data ?? []) as unknown[]).length;
}

describe("AUDITFIX-21: a forbidden system-project grant has a sanctioned repair", () => {
  it("AC1: an unsanctioned edge on a system project is revoked, and audited", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors", a);
    await plant(seed, gen, vendors);
    const before = await revokedAudits(seed);

    const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok, r.error).toBe(true);
    expect(r.revoked).toBe(true);
    expect(await edgeExists(seed, gen, vendors)).toBe(false);
    expect(await revokedAudits(seed), "a real deletion audits").toBe(before + 1);

    // And the audit must NAME the authorizer correctly. Counting rows leaves the actor discipline
    // completely unprotected: auditing as the member, omitting authorizedByMemberId, or recording the
    // wrong `via` all keep the count identical (diff review). An operator act audits as SYSTEM with
    // the authorizer in META — never in the actor field, which would attribute the deletion to a
    // human who only approved it.
    const { data: row } = await db()
      .from("audit_log")
      .select("actor_kind, member_id, meta")
      .eq("team_id", seed.teamId)
      .eq("action", "access.project_revoked")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const audit = row as { actor_kind: string; member_id: string | null; meta: Record<string, unknown> };
    expect(audit.actor_kind, "an operator act audits as system").toBe("system");
    expect(audit.member_id, "and never attributes the act to the approving human").toBeNull();
    const meta = typeof audit.meta === "string" ? JSON.parse(audit.meta) : audit.meta;
    expect(meta.authorizedByMemberId, "the authorizer is named in meta").toBe(a);
    expect(meta.via).toBe("cli");
    expect(meta.repair, "and the trail says this was a repair, not an ordinary revoke").toBe("unsanctioned_system_edge");
  });

  it("AC2: ALL THREE sanctioned pairs are refused, for BOTH actor kinds, and every edge survives", async () => {
    const seed = await team();
    const a = await admin(seed);
    const everyone = await builtinId(seed, EVERYONE_SLUG);
    const external = await builtinId(seed, EXTERNAL_SLUG);
    const pairs: [string, string][] = [
      [await projectId(seed, GENERAL_SLUG), everyone],
      [await projectId(seed, EXTERNAL_SHARED_SLUG), everyone],
      [await projectId(seed, EXTERNAL_SHARED_SLUG), external],
    ];
    // Both actor kinds: a writer can refuse every pair for operator actors and protect only
    // general→everyone for member actors, and a one-pair criterion would never see it.
    for (const [p, g] of pairs) {
      for (const actor of [{ kind: "operator", authorizedByMemberId: a, via: "cli" }, { kind: "member", memberId: a }] as const) {
        const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: p, groupId: g }, actor);
        expect(r.ok, `${actor.kind} must not remove a sanctioned pair`).toBe(false);
        expect(r.error).toMatch(/SANCTIONED/i);
        expect(await edgeExists(seed, p, g), "the substrate edge survives").toBe(true);
      }
    }
  });

  it("AC3: a SQUATTER group carrying a sanctioned slug does not inherit the exemption", async () => {
    const seed = await team();
    const a = await admin(seed);
    const shared = await projectId(seed, EXTERNAL_SHARED_SLUG);
    // groups is unique(team_id, slug), so the real builtin goes first — and it must be `external`,
    // NOT `everyone`: deleting `everyone` cascades away the admin's own builtin membership, which is
    // where posture comes from, so the call would fail at AUTHORITY and prove nothing about identity.
    await db().from("groups").delete().eq("team_id", seed.teamId).eq("slug", EXTERNAL_SLUG).eq("is_builtin", true);
    const { data: sq, error } = await db()
      .from("groups").insert({ team_id: seed.teamId, slug: EXTERNAL_SLUG, name: "squatter", is_builtin: false })
      .select("id, slug, is_builtin").single();
    expect(error, "the squatter must be planted").toBeNull();
    expect([(sq as { slug: string }).slug, (sq as { is_builtin: boolean }).is_builtin], "the fixture holds a BUILTIN slug while NOT being builtin").toEqual([EXTERNAL_SLUG, false]);
    const sqId = (sq as { id: string }).id;
    await plant(seed, shared, sqId);

    const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: shared, groupId: sqId }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok, `slug alone is not identity — is_builtin is half of it: ${r.error}`).toBe(true);
    expect(r.revoked).toBe(true);
  });

  it("AC4: a reserved-slug SOURCE project is PROTECTED, and says so specifically", async () => {
    const seed = await seedTeam();
    const a = await admin(seed);
    const src = await projectAtKind(seed, GENERAL_SLUG, "source");
    const { ensureBuiltins } = await import("@/lib/access/groups");
    expect((await ensureBuiltins(db(), seed.teamId)).ok).toBe(true);
    const everyone = await builtinId(seed, EVERYONE_SLUG);
    await plant(seed, src, everyone);

    const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: src, groupId: everyone }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok).toBe(false);
    // The MESSAGE, not just the refusal: a kind-only gate refuses this pair too — via the
    // not-protected branch — so "refused, edge survives" cannot tell the two implementations apart.
    expect(r.error, "refused as SANCTIONED, not as not-my-case").toMatch(/SANCTIONED/i);
    expect(await edgeExists(seed, src, everyone)).toBe(true);
  });

  it("AC5: and its UNSANCTIONED edge is still revocable", async () => {
    const seed = await seedTeam();
    const a = await admin(seed);
    const src = await projectAtKind(seed, GENERAL_SLUG, "source");
    const vendors = await ordinaryGroup(seed, "vendors", a);
    await plant(seed, src, vendors);

    const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: src, groupId: vendors }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok, r.error).toBe(true);
    expect(r.revoked, "the behavioural discriminator for the protection gate").toBe(true);
  });

  it("AC6: a reserved-slug INITIATIVE is NOT this writer's case", async () => {
    const seed = await seedTeam();
    const a = await admin(seed);
    const init = await projectAtKind(seed, GENERAL_SLUG, "initiative");
    const g = await ordinaryGroup(seed, "leads", a);
    await plant(seed, init, g);

    const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: init, groupId: g }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok, "an initiative is not protected — classifying by the PAIR alone would strand it").toBe(false);
    expect(r.error).toMatch(/not a protected project/);
    expect(await edgeExists(seed, init, g), "and this writer never deletes it").toBe(true);
    // The ordinary writer still handles it, which is the point of refusing rather than delegating.
    const viaOld = await revokeProjectFromGroup(db(), seed.teamId, init, g, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(viaOld.ok, viaOld.error).toBe(true);
    expect(viaOld.revoked).toBe(true);
  });

  it("AC8/AC9: an undetermined identity read refuses, ATTRIBUTED, and deletes nothing", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors", a);
    await plant(seed, gen, vendors);

    for (const [table, needle] of [["projects", /project read failed/], ["groups", /group read failed/]] as const) {
      const faulted = failingSelect(table, `${table} exploded`);
      const r = await revokeUnsanctionedSystemEdge(faulted, seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
      expect(r.ok).toBe(false);
      // Attribution is the whole assertion: a swallowed error yields null, takes the not-found
      // branch, and produces an identical ok:false/edge-survives observable.
      expect(r.error, `${table} read failure must be distinguishable from not-found`).toMatch(needle);
      expect(await edgeExists(seed, gen, vendors)).toBe(true);
    }
  });

  it("AC10: an unauthorized principal is refused, and ZERO identity reads fire", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors", a);
    await plant(seed, gen, vendors);
    const auditsBefore = await revokedAudits(seed);

    const nonAdmin = await admin(seed, { role: "member" });
    const inactive = await admin(seed, { status: "disabled" });
    const externalPosture = await admin(seed, { tier: "external" });
    for (const principal of [nonAdmin, inactive, externalPosture, randomUUID()]) {
      const { client, identityReads } = countingIdentityReads();
      const r = await revokeUnsanctionedSystemEdge(client, seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: principal, via: "cli" });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/principal rejected/);
      // Counting is the ONLY thing that observes the order: "refused, edge survives, no audit" is
      // identical whether identity is read before or after the authority check.
      expect(identityReads(), "nothing about the edge may be read before authorization").toBe(0);
      expect(await edgeExists(seed, gen, vendors)).toBe(true);
    }
    expect(await revokedAudits(seed)).toBe(auditsBefore);

    // POSITIVE CONTROL: without it, a refactor that reads identity off anything but the passed client
    // leaves the counter at 0 for an AUTHORIZED run too, and this criterion goes silently vacuous.
    const { client, identityReads } = countingIdentityReads();
    const ok = await revokeUnsanctionedSystemEdge(client, seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(ok.ok, ok.error).toBe(true);
    expect(identityReads(), "an authorized run DOES read both identities through this client").toBeGreaterThanOrEqual(2);
  });

  it("AC11: no edge-existence oracle — same refusal whether the edge is there or not", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors", a);
    const nonAdmin = await admin(seed, { role: "member" });

    await plant(seed, gen, vendors);
    const withEdge = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: nonAdmin, via: "cli" });
    await db().from("project_groups").delete().eq("team_id", seed.teamId).eq("project_id", gen).eq("group_id", vendors);
    const withoutEdge = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: nonAdmin, via: "cli" });
    expect(withEdge.ok).toBe(false);
    expect(withoutEdge.error, "edge presence is not observable without authority").toBe(withEdge.error);
  });

  it("AC12: a no-op repair does NOT audit", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors", a);
    const before = await revokedAudits(seed);

    const r = await revokeUnsanctionedSystemEdge(db(), seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok).toBe(true);
    expect(r.revoked, "there was nothing to remove").toBe(false);
    expect(await revokedAudits(seed), "a revoke that revoked nothing writes no trail (D3)").toBe(before);
  });

  it("AC13: a row removed AFTER classification is not audited as a deletion", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const vendors = await ordinaryGroup(seed, "vendors", a);
    await plant(seed, gen, vendors);
    const before = await revokedAudits(seed);

    // Remove the row between the identity reads and the delete. RETURNING is what makes the
    // difference observable — the probe-then-blind-delete shape would audit a phantom here.
    const racing = new Proxy(db() as object, {
      get(t, prop, recv) {
        if (prop !== "from") return Reflect.get(t, prop, recv);
        return (name: string) => {
          const q = (t as { from: (n: string) => unknown }).from(name);
          if (name !== "project_groups") return q;
          let isDelete = false;
          const wrap = (b: object): unknown =>
            new Proxy(b, {
              get(bt, bp, br) {
                const v = Reflect.get(bt, bp, br);
                if (bp === "then" && isDelete) {
                  return (res: (x: unknown) => unknown) => {
                    void (async () => {
                      await db().from("project_groups").delete().eq("team_id", seed.teamId).eq("project_id", gen).eq("group_id", vendors);
                      res(await (bt as PromiseLike<unknown>));
                    })();
                  };
                }
                if (typeof v !== "function") return v;
                return (...args: unknown[]) => {
                  if (bp === "delete") isDelete = true;
                  const r2 = (v as (...x: unknown[]) => unknown).apply(bt, args);
                  return r2 === bt ? br : wrap(r2 as object);
                };
              },
            });
          return wrap(q as object);
        };
      },
    }) as DbClient;

    const r = await revokeUnsanctionedSystemEdge(racing, seed.teamId, { projectId: gen, groupId: vendors }, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok).toBe(true);
    expect(r.revoked, "this call removed nothing").toBe(false);
    expect(await revokedAudits(seed), "and must not claim it did").toBe(before);
  });

  it("AC17: the OLD writer now refuses a SANCTIONED edge on a reserved-slug SOURCE project", async () => {
    const seed = await seedTeam();
    const a = await admin(seed);
    const src = await projectAtKind(seed, GENERAL_SLUG, "source");
    const { ensureBuiltins } = await import("@/lib/access/groups");
    expect((await ensureBuiltins(db(), seed.teamId)).ok).toBe(true);
    const everyone = await builtinId(seed, EVERYONE_SLUG);
    await plant(seed, src, everyone);

    // Deletable in merged code before this slice: the old writer read `kind` only and refused only
    // kind==='system', so an authorized admin could remove the substrate edge with no race at all.
    const r = await revokeProjectFromGroup(db(), seed.teamId, src, everyone, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok, "the substrate is not revocable through the general writer").toBe(false);
    expect(await edgeExists(seed, src, everyone), "and the edge survives").toBe(true);
  });

  it("AC16: the old writer still refuses a kind='system' project, unchanged", async () => {
    const seed = await team();
    const a = await admin(seed);
    const gen = await projectId(seed, GENERAL_SLUG);
    const everyone = await builtinId(seed, EVERYONE_SLUG);
    const r = await revokeProjectFromGroup(db(), seed.teamId, gen, everyone, { kind: "operator", authorizedByMemberId: a, via: "cli" });
    expect(r.ok).toBe(false);
    expect(await edgeExists(seed, gen, everyone)).toBe(true);
  });
});

/** Fails READS of one table; writes pass. */
function failingSelect(table: string, message: string): DbClient {
  const real = db();
  const injected = { data: null, error: { message } };
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== table) return q;
        let isWrite = false;
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                if (isWrite) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
                return (res: (x: unknown) => unknown) => res(injected);
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "insert" || bp === "upsert" || bp === "update" || bp === "delete") isWrite = true;
                const r = (v as (...a: unknown[]) => unknown).apply(bt, args);
                if (bp === "single" || bp === "maybeSingle") {
                  return isWrite ? r : { then: (res: (x: unknown) => unknown) => res(injected) };
                }
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
}

/** Counts reads of the edge's IDENTITY tables — the only way to observe authority-first ordering. */
function countingIdentityReads(): { client: DbClient; identityReads: () => number } {
  const real = db();
  let n = 0;
  const client = new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        if (name === "projects" || name === "groups") n += 1;
        return (target as { from: (x: string) => unknown }).from(name);
      };
    },
  }) as DbClient;
  return { client, identityReads: () => n };
}
