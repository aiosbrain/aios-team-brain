import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import type { DbClient } from "@/lib/db/types";
import {
  EVERYONE_SLUG,
  EXTERNAL_SLUG,
  createGroup,
  ensureBuiltins,
  ensurePersonSingleton,
  grantProjectToGroup,
} from "@/lib/access/groups";
import {
  EXTERNAL_SHARED_SLUG,
  GENERAL_SLUG,
  ensureAccessBootstrap,
} from "@/lib/access/bootstrap";

/**
 * AUDITFIX-3 — spec `docs/design/auditfix3-system-project-grant-guard.md`.
 *
 * PREVENTION half only: a forbidden edge on a system project (or on the `source` project destined
 * to become one) cannot be CREATED, and adoption refuses to promote a row already carrying one.
 * Detection is AUDITFIX-22; repair is AUDITFIX-21.
 *
 * Read §4's tuple matrix before touching a refusal case. Four spec rounds each found an
 * implementation that passed the whole suite while `admin.ts grant-project vendors general` still
 * worked, because the criteria left an axis unnamed — the actor, the `opts` shape, group class.
 * Every refusal here therefore names its tuple AND asserts nothing was written.
 */

// ── the four production caller shapes (spec §4, T1-T4) ────────────────────────────────────────
type Tuple = { label: string; actor: (ctx: { member: string }) => string | null; opts: (ctx: { admin: string }) => Record<string, unknown> };
const TUPLES: Tuple[] = [
  { label: "T1 (null, {}) — the no-flag CLI, and bootstrap", actor: () => null, opts: () => ({}) },
  { label: "T2 (null, operator opts) — grant-project --actor", actor: () => null, opts: (c) => ({ authorizedByMemberId: c.admin, via: "cli" }) },
  { label: "T3 (member, {}) — the dashboard creator grant", actor: (c) => c.member, opts: () => ({}) },
  { label: "T4 (member, operator opts)", actor: (c) => c.member, opts: (c) => ({ authorizedByMemberId: c.admin, via: "cli" }) },
];

async function adminMember(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Admin",
      actor_handle: `a-${randomUUID().slice(0, 10)}`,
      role: "admin",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`admin seed failed: ${error?.message}`);
  await placeMemberByTier(seed.teamId, data.id as string, "team");
  return data.id as string;
}

async function project(seed: Seed, slug: string, kind: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug, kind })
    .select("id")
    .single();
  if (error || !data) throw new Error(`project seed failed: ${error?.message}`);
  return data.id as string;
}

async function systemProjectId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id, kind").eq("team_id", seed.teamId).eq("slug", slug).single();
  expect((data as { kind: string }).kind, `${slug} must be kind=system for this fixture`).toBe("system");
  return (data as { id: string }).id;
}

async function builtinId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", slug).eq("is_builtin", true).single();
  return (data as { id: string }).id;
}

async function projectKind(projectId: string): Promise<string> {
  const { data } = await db().from("projects").select("kind").eq("id", projectId).single();
  return (data as { kind: string }).kind;
}

async function edgeCount(seed: Seed): Promise<number> {
  const { data } = await db().from("project_groups").select("project_id").eq("team_id", seed.teamId);
  return ((data ?? []) as unknown[]).length;
}

async function grantAudits(seed: Seed): Promise<number> {
  const { data } = await db().from("audit_log").select("id").eq("team_id", seed.teamId).eq("action", "access.project_granted");
  return ((data ?? []) as unknown[]).length;
}

async function adoptAudits(seed: Seed): Promise<number> {
  const { data } = await db().from("audit_log").select("id").eq("team_id", seed.teamId).eq("action", "access.project_adopted");
  return ((data ?? []) as unknown[]).length;
}

/** Nothing was written: neither the edge nor the audit trail moved. Spec §4 M3. */
async function assertNothingWritten(seed: Seed, before: { edges: number; audits: number }, label: string) {
  expect(await edgeCount(seed), `${label}: no project_groups row`).toBe(before.edges);
  expect(await grantAudits(seed), `${label}: no access.project_granted audit row`).toBe(before.audits);
}

/** A client whose reads of ONE table fail at the adapter boundary — the only way to reach a
 *  fail-closed branch, since a real Postgres SELECT on a live table does not error on demand. */
function clientWithFailingRead(table: string, message = "injected read failure"): DbClient {
  const real = db();
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== table) return q;
        const fail = { then: (res: (x: unknown) => unknown) => res({ data: null, error: { message } }) };
        const wrap = (obj: object): unknown =>
          new Proxy(obj, {
            get(qt, qp) {
              if (qp === "then") return fail.then;
              return () => wrap(fail);
            },
          });
        return wrap(fail);
      };
    },
  }) as DbClient;
}

/** A client whose `project_groups` reads SUCCEED with a row whose embedded group is null — the
 *  shape the FK makes unreachable in Postgres, and the branch a future left-join would need. */
function clientWithNullGroupCensus(groupId: string): DbClient {
  const real = db();
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== "project_groups") return q;
        const rows = { then: (res: (x: unknown) => unknown) => res({ data: [{ group_id: groupId, groups: null }], error: null }) };
        const wrap = (obj: object): unknown =>
          new Proxy(obj, {
            get(qt, qp) {
              if (qp === "then") return rows.then;
              return () => wrap(rows);
            },
          });
        return wrap(rows);
      };
    },
  }) as DbClient;
}

describe("AUDITFIX-3: a system project's grants are the substrate's, and nothing else may create one", () => {
  it("AC1: the real bootstrap still produces EXACTLY its three edges — the guard must admit its own writer", async () => {
    const seed = await seedTeam();
    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, r.error).toBe(true);

    // NB: only `groups` is a registered embed on project_groups (lib/db/pg/relationships.ts), and
    // an UNREGISTERED embed resolves to { data: null, error } — silent emptiness if you ignore the
    // error, which is precisely why the census in bootstrap checks it.
    const { data: projRows } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const slugById = new Map(((projRows ?? []) as { id: string; slug: string }[]).map((p2) => [p2.id, p2.slug]));
    const { data, error } = await db()
      .from("project_groups")
      .select("project_id, group_id, groups(slug, is_builtin)")
      .eq("team_id", seed.teamId);
    expect(error, "the edge read itself must succeed").toBeNull();
    const pairs = ((data ?? []) as { project_id: string; groups: { slug: string; is_builtin: boolean } | null }[])
      .map((r2) => `${slugById.get(r2.project_id)}->${r2.groups?.slug}${r2.groups?.is_builtin ? "" : "(NOT builtin)"}`)
      .sort();
    expect(pairs).toEqual([
      `${EXTERNAL_SHARED_SLUG}->${EVERYONE_SLUG}`,
      `${EXTERNAL_SHARED_SLUG}->${EXTERNAL_SLUG}`,
      `${GENERAL_SLUG}->${EVERYONE_SLUG}`,
    ]);
  });

  it("AC2: a system project to an ORDINARY group is refused under ALL FOUR caller tuples, writing nothing", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await adminMember(seed);
    const general = await systemProjectId(seed, GENERAL_SLUG);

    for (const t of TUPLES) {
      const g = await createGroup(db(), seed.teamId, `vendors-${randomUUID().slice(0, 6)}`, "Vendors", admin);
      const before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };
      const r = await grantProjectToGroup(db(), seed.teamId, general, g.groupId!, t.actor({ member: admin }), t.opts({ admin }));
      expect(r.ok, `${t.label} must be refused`).toBe(false);
      expect(r.error, `${t.label} names the substrate`).toMatch(/system|substrate|sanctioned/i);
      await assertNothingWritten(seed, before, t.label);
    }
  });

  it("AC3: a system project to the WRONG builtin is refused (general->external)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const general = await systemProjectId(seed, GENERAL_SLUG);
    const external = await builtinId(seed, EXTERNAL_SLUG);
    const before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };
    const r = await grantProjectToGroup(db(), seed.teamId, general, external, null, {});
    expect(r.ok).toBe(false);
    await assertNothingWritten(seed, before, "general->external");
  });

  it("AC4: identity is slug AND is_builtin — an ordinary group SLUGGED 'external' is refused external-shared", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const shared = await systemProjectId(seed, EXTERNAL_SHARED_SLUG);
    // A squatter can only be planted directly: the writer refuses a reserved slug for an ordinary
    // group. Direct edge-table writes are legal from test files (single-writer guard scans app/lib/scripts).
    const { data: squatter } = await db()
      .from("groups")
      .insert({ team_id: seed.teamId, slug: `${EXTERNAL_SLUG}-x`, name: "squatter", is_builtin: false })
      .select("id")
      .single();
    await db().from("groups").update({ slug: EXTERNAL_SLUG }).eq("id", (squatter as { id: string }).id);

    const before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };
    const r = await grantProjectToGroup(db(), seed.teamId, shared, (squatter as { id: string }).id, null, {});
    expect(r.ok, "a non-builtin group holding the 'external' slug is not the External built-in").toBe(false);
    await assertNothingWritten(seed, before, "external-shared->squatter");
  });

  it("AC5: a RESERVED SLUG at kind='source' is refused — this is what closes the census->CAS window", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const admin = await adminMember(seed);
    const preAdoption = await project(seed, GENERAL_SLUG, "source");
    const g = await createGroup(db(), seed.teamId, "vendors", "Vendors", admin);

    const before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };
    const r = await grantProjectToGroup(db(), seed.teamId, preAdoption, g.groupId!, null, {});
    expect(r.ok, "a source project already holding a reserved slug is destined for adoption").toBe(false);
    await assertNothingWritten(seed, before, "general@source->vendors");
    expect(await projectKind(preAdoption)).toBe("source");
  });

  it("AC6: a system project to a PERSON SINGLETON is refused — group class is not an exemption axis", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await adminMember(seed);
    const general = await systemProjectId(seed, GENERAL_SLUG);
    const singleton = await ensurePersonSingleton(db(), seed.teamId, admin, admin);
    expect(singleton.ok, singleton.error).toBe(true);

    // T1 — `admin.ts grant-project person-<id> general`, which resolves any group by slug.
    let before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };
    const asOperator = await grantProjectToGroup(db(), seed.teamId, general, singleton.groupId!, null, {});
    expect(asOperator.ok, "the CLI must not reach the corpus through a person group").toBe(false);
    await assertNothingWritten(seed, before, "singleton T1");

    // T3 — the SAME shape the legitimate creator grant uses (AC7), pointed at a system project.
    before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };
    const asSelf = await grantProjectToGroup(db(), seed.teamId, general, singleton.groupId!, admin, {});
    expect(asSelf.ok, "the creator-grant shape does not become a key to the corpus").toBe(false);
    await assertNothingWritten(seed, before, "singleton T3");
  });

  it("AC7: a reserved-slug INITIATIVE grants normally through the dashboard's own tuple — the exemption is by KIND", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const creator = await adminMember(seed);
    // What `createProjectAction` mints when a human types "General": slugify -> 'general', kind 'initiative'.
    const initiative = await project(seed, GENERAL_SLUG, "initiative");
    // Reproduce grantProjectToCreator's whole body — ensurePersonSingleton can return before the
    // writer, so asserting the path is unconditional would have been false (spec §4 AC7).
    const singleton = await ensurePersonSingleton(db(), seed.teamId, creator, creator);
    expect(singleton.ok, singleton.error).toBe(true);
    const granted = await grantProjectToGroup(db(), seed.teamId, initiative, singleton.groupId!, creator, {});
    expect(granted.ok, `the creator must not be stranded: ${granted.error}`).toBe(true);

    const { data } = await db().from("project_groups").select("project_id").eq("team_id", seed.teamId).eq("project_id", initiative).eq("group_id", singleton.groupId!).maybeSingle();
    expect(data, "the creator grant lands").not.toBeNull();
  });

  it("AC8: bootstrap still REFUSES to adopt that initiative — the shipped behaviour AC7 depends on", async () => {
    const seed = await seedTeam();
    const initiative = await project(seed, GENERAL_SLUG, "initiative");
    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, "an initiative squatting a reserved slug wedges bootstrap, loudly").toBe(false);
    expect(r.error).toMatch(/initiative/);
    expect(await projectKind(initiative)).toBe("initiative");
  });

  it("AC9: a NON-reserved, non-system project is unaffected under both actor shapes", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const admin = await adminMember(seed);
    const ordinary = await project(seed, `roadmap-${randomUUID().slice(0, 6)}`, "initiative");
    const g1 = await createGroup(db(), seed.teamId, "leads", "Leads", admin);
    const g2 = await createGroup(db(), seed.teamId, "eng", "Eng", admin);

    expect((await grantProjectToGroup(db(), seed.teamId, ordinary, g1.groupId!, null, {})).ok, "T1").toBe(true);
    expect((await grantProjectToGroup(db(), seed.teamId, ordinary, g2.groupId!, admin, {})).ok, "T3").toBe(true);
  });

  it("AC10: a PRE-EXISTING forbidden edge is REFUSED, not reported as 'already granted'", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await adminMember(seed);
    const general = await systemProjectId(seed, GENERAL_SLUG);
    const g = await createGroup(db(), seed.teamId, "vendors", "Vendors", admin);
    // Plant the edge out of band — the state a fleet could already be in (spec §3b.4).
    await db().from("project_groups").insert({ team_id: seed.teamId, project_id: general, group_id: g.groupId!, added_by: null });

    const r = await grantProjectToGroup(db(), seed.teamId, general, g.groupId!, null, {});
    expect(r.ok, "the guard runs BEFORE the existence probe; ok:true here reads as sanction").toBe(false);
    expect(r.created, "and it is not a cheerful 'nothing written'").not.toBe(false);
    const { data } = await db().from("project_groups").select("project_id").eq("team_id", seed.teamId).eq("project_id", general).eq("group_id", g.groupId!).maybeSingle();
    expect(data, "this slice never deletes — repair is AUDITFIX-21").not.toBeNull();
  });

  it("AC11: an unreadable PROJECT refuses the grant AND says so — attribution, not a not-found lookalike", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await adminMember(seed);
    const general = await systemProjectId(seed, GENERAL_SLUG);
    const g = await createGroup(db(), seed.teamId, "vendors", "Vendors", admin);
    const before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };

    const r = await grantProjectToGroup(clientWithFailingRead("projects", "project read exploded"), seed.teamId, general, g.groupId!, null, {});
    expect(r.ok).toBe(false);
    // Without this the criterion is green under "swallow the error" too: data=null takes the
    // not-found branch and produces the same ok:false/no-edge observable (round 4 HIGH 1).
    expect(r.error, "an undetermined read must not be reported as 'not found'").toMatch(/project read exploded|read fail/i);
    await assertNothingWritten(seed, before, "faulted project read");
  });

  it("AC12: an unreadable GROUP refuses the grant AND says so, on a PROTECTED project", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await adminMember(seed);
    // PROTECTED on purpose: an implementation may read the group only when the guard applies, and
    // on an ordinary project the faulted read is never reached — a vacuous criterion (round 4 H1).
    const general = await systemProjectId(seed, GENERAL_SLUG);
    const g = await createGroup(db(), seed.teamId, "vendors", "Vendors", admin);
    const before = { edges: await edgeCount(seed), audits: await grantAudits(seed) };

    const r = await grantProjectToGroup(clientWithFailingRead("groups", "group read exploded"), seed.teamId, general, g.groupId!, null, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/group read exploded|read fail/i);
    await assertNothingWritten(seed, before, "faulted group read");
  });

  it("AC13: adoption REFUSES a source row carrying an unsanctioned grant — kind unchanged, edge named, no adoption audit", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const admin = await adminMember(seed);
    const preAdoption = await project(seed, GENERAL_SLUG, "source");
    const g = await createGroup(db(), seed.teamId, "vendors", "Vendors", admin);
    // The §0b state: granted while ordinary, BEFORE this guard existed.
    await db().from("project_groups").insert({ team_id: seed.teamId, project_id: preAdoption, group_id: g.groupId!, added_by: null });
    const auditsBefore = await adoptAudits(seed);

    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, "silent promotion with a forbidden grant is the defect").toBe(false);
    expect(r.error, "the refusal names the edge").toMatch(/vendors/);
    expect(await projectKind(preAdoption), "the flip must not happen").toBe("source");
    expect(await adoptAudits(seed)).toBe(auditsBefore);
  });

  it("AC14: adoption FAILS CLOSED on an unreadable grant census — kind still source, ON THE ROW", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const preAdoption = await project(seed, GENERAL_SLUG, "source");
    // Verify the row FIRST, so a later refusal cannot pass because something claimed it was absent.
    expect(await projectKind(preAdoption)).toBe("source");

    const r = await ensureAccessBootstrap(clientWithFailingRead("project_groups", "census exploded"), seed.teamId);
    expect(r.ok).toBe(false);
    expect(r.error, "attributable to the census, not to a missing row").toMatch(/census exploded|census/i);
    expect(await projectKind(preAdoption), "an undetermined read must not promote").toBe("source");
  });

  it("AC15: an edge whose GROUP does not resolve is unsanctioned, never absent", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const preAdoption = await project(seed, GENERAL_SLUG, "source");
    const everyone = await builtinId(seed, EVERYONE_SLUG);

    // The FK makes this unseedable in Postgres (composite FK + one snapshot), so it is injected:
    // the branch exists for a future left-join or two-read census, as in the oracle.
    const r = await ensureAccessBootstrap(clientWithNullGroupCensus(everyone), seed.teamId);
    expect(r.ok, "an unresolvable group is not 'no grants'").toBe(false);
    expect(await projectKind(preAdoption)).toBe("source");
  });

  it("AC16: adoption still promotes a CLEAN row and audits it", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const preAdoption = await project(seed, GENERAL_SLUG, "source");
    const auditsBefore = await adoptAudits(seed);

    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, r.error).toBe(true);
    expect(await projectKind(preAdoption)).toBe("system");
    expect(await adoptAudits(seed), "the adoption is loudly audited").toBe(auditsBefore + 1);
  });

  it("AC17: a faulted existence probe refuses instead of re-upserting and minting a false created:true", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await adminMember(seed);
    const general = await systemProjectId(seed, GENERAL_SLUG);
    const everyone = await builtinId(seed, EVERYONE_SLUG);
    // A distinctive added_by on the SANCTIONED edge, so a re-upsert is visible byte-for-byte.
    await db().from("project_groups").update({ added_by: admin }).eq("team_id", seed.teamId).eq("project_id", general).eq("group_id", everyone);
    const auditsBefore = await grantAudits(seed);

    const r = await grantProjectToGroup(clientWithFailingRead("project_groups", "probe exploded"), seed.teamId, general, everyone, null, {});
    expect(r.ok, "a read failure must not be read as 'no edge yet'").toBe(false);
    const { data } = await db().from("project_groups").select("added_by").eq("team_id", seed.teamId).eq("project_id", general).eq("group_id", everyone).single();
    expect((data as { added_by: string | null }).added_by, "added_by must not be re-clobbered").toBe(admin);
    expect(await grantAudits(seed), "and no audit row may claim created:true").toBe(auditsBefore);
  });
});
