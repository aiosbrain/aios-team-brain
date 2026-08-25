import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, type Seed } from "./helpers";
import type { DbClient } from "@/lib/db/types";
import { createGroup, grantProjectToGroup, revokeProjectFromGroup, type RevokeActor } from "@/lib/access/groups";

/**
 * AUDITFIX-26 — spec `docs/design/auditfix26-phantom-revoke-audit.md`.
 *
 * A revoke that revoked nothing must not claim it did. `revokeProjectFromGroup` probed, deleted
 * blind, then audited unconditionally — so the loser of a concurrent race wrote an
 * `access.project_revoked` row for a deletion that never happened.
 *
 * ⚠️ EVERY criterion here runs BOTH actor kinds. A fix that moves only one audit branch inside the
 * guard is a real implementation, and with a single-actor fixture it passes everything while a raced
 * member revoke still phantoms — the twentieth time in this lane a mutation has been aimed at a
 * criterion that could not tell it from correct.
 */

/** Both actor kinds, every time — the branch a single-actor fixture leaves untested is where the
 *  phantom survives. */
const actorOf = (kind: "operator" | "member", member: string): RevokeActor =>
  kind === "operator" ? { kind: "operator", authorizedByMemberId: member, via: "cli" } : { kind: "member", memberId: member };

async function adminMember(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "A",
      actor_handle: `a-${randomUUID().slice(0, 10)}`,
      role: "admin",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  expect(error, "fixture admin must insert").toBeNull();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

async function ordinaryProject(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 8)}`, name: "P", kind: "initiative" })
    .select("id")
    .single();
  expect(error, "fixture project must insert").toBeNull();
  return (data as { id: string }).id;
}

async function revokedAudits(seed: Seed): Promise<number> {
  const { data } = await db().from("audit_log").select("id").eq("team_id", seed.teamId).eq("action", "access.project_revoked");
  return ((data ?? []) as unknown[]).length;
}

async function edgeExists(seed: Seed, p: string, g: string): Promise<boolean> {
  const { data } = await db().from("project_groups").select("project_id").eq("team_id", seed.teamId).eq("project_id", p).eq("group_id", g).maybeSingle();
  return data !== null;
}

/**
 * Removes the edge AFTER the probe has read it, so the delete finds nothing — the race, made real.
 *
 * ⚠️ Returns a POSITIVE CONTROL alongside the client. Without it, an injector that never fired
 * produces the same `revoked:false` + no-audit observable as the fix working, so AC1 would pass
 * while testing nothing — the failure mode a read-counter with no positive control had in the
 * sibling slice.
 */
function deletesAfterProbe(seed: Seed, p: string, g: string): { client: DbClient; fired: () => boolean } {
  const real = db();
  let probed = false;
  const client = new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== "project_groups") return q;
        let isDelete = false;
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then" || bp === "maybeSingle") {
                const settle = async (): Promise<unknown> => {
                  const out = await (bp === "maybeSingle"
                    ? (Reflect.get(bt, "maybeSingle") as () => PromiseLike<unknown>).call(bt)
                    : (bt as PromiseLike<unknown>));
                  // The PROBE has now read the row; remove it before the delete runs.
                  if (!isDelete && !probed) {
                    probed = true;
                    await real.from("project_groups").delete().eq("team_id", seed.teamId).eq("project_id", p).eq("group_id", g);
                  }
                  return out;
                };
                // ⚠️ BOTH handlers are forwarded. An earlier version passed only `res`, so a
                // rejection anywhere inside `settle` — the probe read, or the injected delete —
                // produced a promise nothing ever resolved: the awaiting writer hung forever and the
                // error was invisible. A harness whose only failure mode is a hang has no
                // termination argument; a rejected read must fail the criterion, loudly.
                type Handlers = (ok: (x: unknown) => unknown, bad: (e: unknown) => unknown) => void;
                const forward: Handlers = (ok, bad) => void settle().then(ok, bad);
                if (bp === "maybeSingle") return () => ({ then: forward });
                return forward;
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "delete") isDelete = true;
                const r = (v as (...x: unknown[]) => unknown).apply(bt, args);
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
  return { client, fired: () => probed };
}

describe("AUDITFIX-26: a revoke that revoked nothing must not claim it did", () => {
  it("AC1: a row removed between the probe and the delete is NOT audited — for BOTH actor kinds", async () => {
    for (const which of ["operator", "member"] as const) {
      const seed = await seedTeam();
      const a = await adminMember(seed);
      const project = await ordinaryProject(seed);
      const g = await createGroup(db(), seed.teamId, "leads", "Leads", a);
      expect(g.ok, `fixture group: ${g.error}`).toBe(true);
      const group = g.groupId as string;
      expect((await grantProjectToGroup(db(), seed.teamId, project, group, a)).ok, "fixture grant").toBe(true);
      // The edge must really be there, or the "race" is a genuine no-op and AC1 proves nothing.
      expect(await edgeExists(seed, project, group), `${which}: fixture edge must exist before the race`).toBe(true);
      const before = await revokedAudits(seed);

      const actor = actorOf(which, a);
      const race = deletesAfterProbe(seed, project, group);
      const r = await revokeProjectFromGroup(race.client, seed.teamId, project, group, actor);

      expect(race.fired(), `${which}: positive control — the injected concurrent delete must have run`).toBe(true);
      expect(r.ok, `${which}: ${r.error}`).toBe(true);
      expect(r.revoked, `${which}: this call removed nothing`).toBe(false);
      expect(await revokedAudits(seed), `${which}: and must not claim it did`).toBe(before);
      expect(await edgeExists(seed, project, group), "the other revoke really did remove it").toBe(false);
    }
  });

  it("AC2/AC3: a REAL deletion still audits, with the right actor for each kind", async () => {
    for (const which of ["operator", "member"] as const) {
      const seed = await seedTeam();
      const a = await adminMember(seed);
      const project = await ordinaryProject(seed);
      const g = await createGroup(db(), seed.teamId, "leads", "Leads", a);
      expect(g.ok, `fixture group: ${g.error}`).toBe(true);
      const group = g.groupId as string;
      expect((await grantProjectToGroup(db(), seed.teamId, project, group, a)).ok, "fixture grant").toBe(true);

      const before = await revokedAudits(seed);
      const actor = actorOf(which, a);
      const r = await revokeProjectFromGroup(db(), seed.teamId, project, group, actor);
      expect(r.ok, r.error).toBe(true);
      expect(r.revoked).toBe(true);
      // EXACTLY one — "the latest row looks right" is also satisfied by a duplicated audit.
      expect(await revokedAudits(seed), `${which}: one real deletion writes one trail row`).toBe(before + 1);

      const { data } = await db()
        .from("audit_log")
        .select("actor_kind, member_id, meta")
        .eq("team_id", seed.teamId)
        .eq("action", "access.project_revoked")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = data as { actor_kind: string; member_id: string | null; meta: Record<string, unknown> | string };
      const meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta;
      if (which === "operator") {
        // An operator act audits as SYSTEM with the authorizer in META — never in the actor field,
        // which would attribute a destructive act to the human who merely approved it.
        expect(row.actor_kind).toBe("system");
        expect(row.member_id).toBeNull();
        expect(meta.authorizedByMemberId).toBe(a);
        expect(meta.via).toBe("cli");
      } else {
        expect(row.actor_kind).toBe("member");
        expect(row.member_id).toBe(a);
      }
    }
  });

  it("AC4: a genuine no-op is unchanged — no audit, for both actor kinds", async () => {
    for (const which of ["operator", "member"] as const) {
      const seed = await seedTeam();
      const a = await adminMember(seed);
      const project = await ordinaryProject(seed);
      const g = await createGroup(db(), seed.teamId, "leads", "Leads", a);
      expect(g.ok, `fixture group: ${g.error}`).toBe(true);
      const before = await revokedAudits(seed);

      const actor = actorOf(which, a);
      const r = await revokeProjectFromGroup(db(), seed.teamId, project, g.groupId as string, actor);
      expect(r.ok).toBe(true);
      expect(r.revoked, "there was never an edge").toBe(false);
      expect(await revokedAudits(seed), "D3: a revoke that revoked nothing writes no trail").toBe(before);
    }
  });
});
