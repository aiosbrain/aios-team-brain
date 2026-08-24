import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, type Seed } from "./helpers";
import type { DbClient } from "@/lib/db/types";
import { censusTeamSystemEdges, createGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap, ensureAccessBootstrapAllTeams, EXTERNAL_SHARED_SLUG, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { describeUnsanctionedEdges } from "@/lib/access/system-projects";
import { assessAccessHealth } from "@/lib/admin/access-health";
import { EXTERNAL_SLUG } from "@/lib/access/groups";

/**
 * AUDITFIX-23 — spec `docs/design/auditfix23-system-edge-census.md`.
 *
 * The DETECTOR: find an edge on a `kind='system'` project that the writer would refuse, on the
 * scheduled path AND the operator-asks path, from ONE shared predicate.
 *
 * ⚠️ Read §4 before touching a criterion. Three rounds across two models found, repeatedly, that my
 * criteria named things a test cannot identify — "the census read" (four candidates on one tick),
 * "the last sanctioned edge" (order-dependent), "both names appear" (order-dependent). Every fixture
 * precondition is asserted, and nothing here depends on timing.
 */

async function bareTeam(): Promise<Seed> {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok, "fixture: bootstrap must converge").toBe(true);
  return seed;
}

async function projectId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", slug).single();
  return (data as { id: string }).id;
}

async function builtinId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", slug).eq("is_builtin", true).single();
  return (data as { id: string }).id;
}

async function ordinaryGroup(seed: Seed, slug: string): Promise<string> {
  const g = await createGroup(db(), seed.teamId, slug, slug, seed.memberId);
  expect(g.ok, `fixture group '${slug}': ${g.error}`).toBe(true);
  expect(g.groupId, `fixture group '${slug}' must have an id`).toBeTruthy();
  return g.groupId as string;
}

/** A `kind='system'` project with a NON-reserved slug — only reachable out of band. */
async function legacySystemProject(seed: Seed, slug = "legacy-system"): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug, kind: "system" })
    .select("id")
    .single();
  expect(error, "fixture: the non-reserved system project must insert").toBeNull();
  return (data as { id: string }).id;
}

/** Plant an edge the writer would refuse. Out of band on purpose — the writer refuses it. */
async function plant(seed: Seed, project: string, group: string): Promise<void> {
  const { error } = await db()
    .from("project_groups")
    .insert({ team_id: seed.teamId, project_id: project, group_id: group, added_by: null });
  expect(error, "fixture: the forbidden edge must actually be planted").toBeNull();
}

async function failureFor(seed: Seed): Promise<string | undefined> {
  const r = await ensureAccessBootstrapAllTeams(db());
  return r.failed.find((f) => f.teamId === seed.teamId)?.error;
}

/** Fails READS of one table; writes pass. */
function clientWithFailingSelect(table: string, message: string): DbClient {
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

/**
 * Intercepts THE CENSUS READ specifically, by its SELECT SHAPE.
 *
 * `project_groups` is read four times per team per converged tick — the writer's existence probe once
 * per sanctioned grant, plus AUDITFIX-3's adopt census — so keying on the table name fires on the
 * wrong read and reds a correct implementation. The census is the only statement embedding BOTH
 * `projects(` and `groups(`; the match is NORMALISED (whitespace stripped) because
 * `projects (kind, slug)` with a space compiles, and a literal matcher would silently observe nothing.
 */
function interceptCensusRead(onRead: () => Promise<void> | void, opts: { transform?: (rows: unknown[]) => unknown[] } = {}) {
  const real = db();
  let intercepted = 0;
  const client = new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== "project_groups") return q;
        let spec = "";
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                const flat = spec.replace(/\s+/g, "");
                const isCensus = flat.includes("projects(") && flat.includes("groups(");
                if (!isCensus) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
                intercepted += 1;
                return (res: (x: unknown) => unknown) => {
                  void (async () => {
                    await onRead();
                    const out = await (bt as PromiseLike<{ data: unknown[] | null; error: unknown }>);
                    res(opts.transform && out.data ? { ...out, data: opts.transform(out.data) } : out);
                  })();
                };
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "select") spec = String(args[0] ?? "");
                const r = (v as (...a: unknown[]) => unknown).apply(bt, args);
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
  return { client, count: () => intercepted };
}

/**
 * Faults ONLY the census read, keyed on its select shape.
 *
 * ⚠️ A blunt "fault every `project_groups` read" injector CANNOT test this: it breaks the writer's
 * three existence probes too, so convergence itself returns ok:false and the team is "reported failed"
 * for the BOOTSTRAP reason — the fail-closed criterion passing while testing nothing. Spec round 3
 * predicted exactly that, and the first version of AC6 built it anyway; the swallow-the-census-error
 * mutation reddened AC12 and left AC6 green, which is how it was caught.
 */
function clientWithFailingCensusRead(message: string): DbClient {
  const real = db();
  const injected = { data: null, error: { message } };
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== "project_groups") return q;
        let spec = "";
        const wrap = (b: object): unknown =>
          new Proxy(b, {
            get(bt, bp, br) {
              const v = Reflect.get(bt, bp, br);
              if (bp === "then") {
                const flat = spec.replace(/\s+/g, "");
                if (!(flat.includes("projects(") && flat.includes("groups("))) {
                  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
                }
                return (res: (x: unknown) => unknown) => res(injected);
              }
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (bp === "select") spec = String(args[0] ?? "");
                const r = (v as (...a: unknown[]) => unknown).apply(bt, args);
                return r === bt ? br : wrap(r as object);
              };
            },
          });
        return wrap(q as object);
      };
    },
  }) as DbClient;
}

describe("AUDITFIX-23: a forbidden system-project grant is found without an operator asking", () => {
  it("AC1: a forbidden edge on external-shared is reported", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, EXTERNAL_SHARED_SLUG), await ordinaryGroup(seed, "vendors"));
    expect(await failureFor(seed)).toMatch(/external-shared→vendors/);
  });

  it("AC1b: and on general — both reserved projects, independently", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, GENERAL_SLUG), await ordinaryGroup(seed, "vendors"));
    expect(await failureFor(seed)).toMatch(/general→vendors/);
  });

  it("AC2: and on a NON-reserved kind='system' project", async () => {
    const seed = await bareTeam();
    await plant(seed, await legacySystemProject(seed), await ordinaryGroup(seed, "vendors"));
    expect(await failureFor(seed)).toMatch(/legacy-system→vendors/);
  });

  it("AC2c: and to the WRONG BUILT-IN — general→external, the edge this program began with", async () => {
    const seed = await bareTeam();
    // The sanctioned set is three PAIRS, not "built-ins are fine". An implementation reading
    // "system → non-builtin is forbidden, any builtin target is sanctioned" passes every criterion
    // whose fixture uses an ordinary group, while THIS one stays invisible.
    await plant(seed, await projectId(seed, GENERAL_SLUG), await builtinId(seed, EXTERNAL_SLUG));
    expect(await failureFor(seed)).toMatch(/general→external/);
  });

  it("AC2d: and the operator path reports that same wrong-built-in edge", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, GENERAL_SLUG), await builtinId(seed, EXTERNAL_SLUG));
    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    expect(h.blockers.join(" | ")).toMatch(/general→external/);
  });

  it("AC2b: MULTIPLE edges are all counted, sample names EXACT pairs, under PERMUTED row order", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, GENERAL_SLUG), await ordinaryGroup(seed, "vendors"));
    await plant(seed, await projectId(seed, EXTERNAL_SHARED_SLUG), await ordinaryGroup(seed, "contractors"));
    await plant(seed, await legacySystemProject(seed), await ordinaryGroup(seed, "auditors"));

    const forward = await censusTeamSystemEdges(db(), seed.teamId);
    expect(forward.ok).toBe(true);
    expect(forward.edges.length, "the count is exact — a `find` implementation reports 1").toBe(3);

    // The sort is CLIENT-SIDE and the adapter orders only when asked, so a no-sort implementation can
    // receive rows already in order and pass by luck. Feed both orders.
    const asc = describeUnsanctionedEdges(forward.edges);
    const desc = describeUnsanctionedEdges([...forward.edges].reverse());
    expect(asc, "the summary is stable under permutation").toBe(desc);
    expect(asc).toMatch(/^3 unsanctioned edge\(s\) on system projects: /);
    expect(asc).toMatch(/external-shared→contractors/);
    expect(asc).toMatch(/general→vendors/);
  });

  it("AC3: the census runs when convergence RETURNED a failure — the outcome names the edge", async () => {
    const seed = await seedTeam();
    // Wedge General with a reserved-slug initiative (bootstrap refuses to adopt it), and plant a
    // forbidden edge on an already-system external-shared.
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await plant(seed, await projectId(seed, EXTERNAL_SHARED_SLUG), await ordinaryGroup(seed, "vendors"));
    await db().from("projects").update({ kind: "initiative" }).eq("team_id", seed.teamId).eq("slug", GENERAL_SLUG);

    const err = await failureFor(seed);
    expect(err, "convergence fails on the General leg, and the census must still run").toMatch(/external-shared→vendors/);
  });

  it("AC4: the census runs when convergence THREW — the loudest case must not go silent", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, EXTERNAL_SHARED_SLUG), await ordinaryGroup(seed, "vendors"));

    // Make CONVERGENCE throw while leaving the census's own reads working. `groups` is read by
    // ensureBuiltins; project_groups (the census) is untouched. A shared try/catch would swallow this
    // and skip the census entirely — passing AC3, which only exercises a RETURNED failure.
    const real = db();
    const thrower = new Proxy(real as object, {
      get(target, prop, recv) {
        if (prop !== "from") return Reflect.get(target, prop, recv);
        return (name: string) => {
          if (name === "groups") throw new Error("convergence exploded");
          return (target as { from: (n: string) => unknown }).from(name);
        };
      },
    }) as DbClient;

    const r = await ensureAccessBootstrapAllTeams(thrower);
    const err = r.failed.find((f) => f.teamId === seed.teamId)?.error;
    expect(err, "the census still ran and named the edge").toMatch(/external-shared→vendors/);
  });

  it("AC6b: a census that THROWS is that team's failure, and later teams still get outcomes", async () => {
    const a = await bareTeam();
    const b = await bareTeam();
    // A throw escaping the per-team guard would abort every REMAINING team and land as one
    // fleet-level row — converting one team's finding into a fleet outage.
    const seen: string[] = [];
    const real = db();
    const thrower = new Proxy(real as object, {
      get(target, prop, recv) {
        if (prop !== "from") return Reflect.get(target, prop, recv);
        return (name: string) => {
          const q = (target as { from: (n: string) => unknown }).from(name);
          if (name !== "project_groups") return q;
          let spec = "";
          const wrap = (bl: object): unknown =>
            new Proxy(bl, {
              get(bt, bp, br) {
                const v = Reflect.get(bt, bp, br);
                if (bp === "then" && spec.replace(/\s+/g, "").includes("projects(")) {
                  throw new Error("census exploded");
                }
                if (typeof v !== "function") return v;
                return (...args: unknown[]) => {
                  if (bp === "select") spec = String(args[0] ?? "");
                  const rr = (v as (...x: unknown[]) => unknown).apply(bt, args);
                  return rr === bt ? br : wrap(rr as object);
                };
              },
            });
          return wrap(q as object);
        };
      },
    }) as DbClient;

    const r = await ensureAccessBootstrapAllTeams(thrower, { onOutcome: (o) => { seen.push(o.teamId); } });
    expect(seen, "every team still reported").toEqual(expect.arrayContaining([a.teamId, b.teamId]));
    for (const t of [a, b]) {
      expect(r.failed.find((f) => f.teamId === t.teamId)?.error, "each team carries its own census throw").toMatch(/census/i);
    }
  });

  it("AC6: the census FAILS CLOSED on a team that otherwise converges cleanly", async () => {
    const seed = await bareTeam();
    // ONLY the census read is faulted — see clientWithFailingCensusRead. Convergence must still
    // succeed, so the ONLY path to a failed outcome is the census failing closed.
    const faulted = clientWithFailingCensusRead("census exploded");
    const r = await ensureAccessBootstrapAllTeams(faulted);
    const err = r.failed.find((f) => f.teamId === seed.teamId)?.error;
    expect(err, "an undetermined census is a failure, never 'no forbidden edges'").toBeTruthy();
    expect(err, "and it is attributable to the CENSUS, not to convergence").toMatch(/census exploded|census/i);
  });

  it("AC8: a clean team is not reported", async () => {
    const seed = await bareTeam();
    const r = await ensureAccessBootstrapAllTeams(db());
    expect(r.failed.some((f) => f.teamId === seed.teamId), "no finding on a converged team").toBe(false);
    const census = await censusTeamSystemEdges(db(), seed.teamId);
    expect(census.ok).toBe(true);
    expect(census.edges).toEqual([]);
  });

  it("AC5: the census READ happens after all three sanctioned edges exist", async () => {
    const seed = await bareTeam();
    const legacy = await legacySystemProject(seed);
    const vendors = await ordinaryGroup(seed, "vendors");
    // Remove ALL THREE sanctioned edges — "the last one" would couple the oracle to a grant order
    // nothing pins. Convergence must restore them BEFORE the census reads. The forbidden edge is
    // planted AFTER the wipe, or the wipe would take it too.
    await db().from("project_groups").delete().eq("team_id", seed.teamId).neq("project_id", "00000000-0000-0000-0000-000000000000");
    expect((await censusTeamSystemEdges(db(), seed.teamId)).edges.length, "precondition: wiped").toBe(0);
    await plant(seed, legacy, vendors);
    let sanctionedAtCensusTime = -1;
    const { client, count } = interceptCensusRead(async () => {
      const { data } = await db()
        .from("project_groups")
        .select("project_id, projects(kind, slug), groups(slug, is_builtin)")
        .eq("team_id", seed.teamId);
      sanctionedAtCensusTime = ((data ?? []) as { projects: { kind: string } | null }[]).filter(
        (r) => r.projects?.kind === "system"
      ).length;
    });

    const r = await ensureAccessBootstrapAllTeams(client);
    expect(count(), "the oracle must have intercepted exactly one census read").toBe(1);
    // 3 sanctioned (restored by convergence) + the planted forbidden one.
    expect(sanctionedAtCensusTime, "convergence completed before the census read").toBe(4);
    expect(r.failed.find((f) => f.teamId === seed.teamId)?.error).toMatch(/legacy-system→vendors/);
  });

  it("AC10: assessAccessHealth reports a forbidden edge on general", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, GENERAL_SLUG), await ordinaryGroup(seed, "vendors"));
    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    expect(h.blockers.join(" | ")).toMatch(/general→vendors/);
  });

  it("AC10b: and on external-shared, independently", async () => {
    const seed = await bareTeam();
    await plant(seed, await projectId(seed, EXTERNAL_SHARED_SLUG), await ordinaryGroup(seed, "vendors"));
    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    expect(h.blockers.join(" | ")).toMatch(/external-shared→vendors/);
  });

  it("AC10c: and on a non-reserved system project", async () => {
    const seed = await bareTeam();
    await plant(seed, await legacySystemProject(seed), await ordinaryGroup(seed, "vendors"));
    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    expect(h.blockers.join(" | ")).toMatch(/legacy-system→vendors/);
  });

  it("AC11: assessAccessHealth stays healthy on a clean team", async () => {
    const seed = await bareTeam();
    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.blockers.join(" | "), "no census blocker on a converged team").not.toMatch(/unsanctioned edge/);
  });

  it("AC12: assessAccessHealth FAILS CLOSED on an undetermined census", async () => {
    const seed = await bareTeam();
    const faulted = clientWithFailingCensusRead("census exploded");
    const h = await assessAccessHealth(faulted, seed.teamId);
    expect(h.healthy, "an unverifiable team is never certified healthy").toBe(false);
    expect(h.blockers.join(" | ")).toMatch(/UNVERIFIED|census/i);
  });

  it("AC7: a legitimate reserved-slug INITIATIVE's creator edge is never called unsanctioned", async () => {
    const seed = await seedTeam();
    const { ensurePersonSingleton, grantProjectToGroup } = await import("@/lib/access/groups");
    // What createProjectAction mints when a human types "General": slugify -> 'general', initiative.
    const { data, error } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: GENERAL_SLUG, name: "General", kind: "initiative" })
      .select("id")
      .single();
    expect(error, "fixture: the initiative must insert").toBeNull();
    const singleton = await ensurePersonSingleton(db(), seed.teamId, seed.memberId, seed.memberId);
    expect(singleton.ok, singleton.error).toBe(true);
    const granted = await grantProjectToGroup(db(), seed.teamId, (data as { id: string }).id, singleton.groupId!, seed.memberId, {});
    expect(granted.ok, `the creator grant must be legal: ${granted.error}`).toBe(true);

    const census = await censusTeamSystemEdges(db(), seed.teamId);
    expect(census.ok).toBe(true);
    expect(census.edges, "an initiative is not a system project — its creator edge is not a finding").toEqual([]);

    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.blockers.join(" | "), "and the operator path agrees").not.toMatch(/unsanctioned edge/);
    // The team IS unhealthy, but for the SEPARATE, correct reason: unique(team_id, slug) means the
    // system General cannot exist alongside the initiative, so the bootstrap never completed.
    expect(h.blockers.join(" | "), "the missing system project is its own blocker").toMatch(/does not exist/);
  });
});
