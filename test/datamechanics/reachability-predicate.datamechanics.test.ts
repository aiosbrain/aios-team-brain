import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { findUnpartitionedItems } from "@/lib/projects/context/coverage";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";

/**
 * AUDITFIX-15A — the ONE definition of "can any eligible principal read this item at all?"
 * (`docs/design/auditfix15a-reachability-predicate.md` §1).
 *
 * THE DEFECT THIS MATRIX EXISTS FOR: the shipped predicate decided an item was reachable when its
 * project had ANY `project_groups` grant, while the oracle requires an ELIGIBLE PRINCIPAL to hold a
 * `group_members` row in a granted group. A project granted only to a group nobody is in therefore
 * read as covered while nobody could read it — and `assessAccessHealth` turned that under-report
 * into a clean bill of health.
 *
 * Every row below is a clause of the oracle's rule, and each cites the line it encodes. The two
 * halves of AC2 are ONE BIT APART on purpose: a predicate that ignores `is_builtin` passes one and
 * fails the other, which is precisely the proxy a prose criterion would have blessed.
 */

/** A member row inserted DIRECTLY: the inert cases are rows the sanctioned writer refuses to create
 *  (`addMemberToGroup` gates on `isPrincipal`), and the property under test is that such a row —
 *  "even if a membership row sneaks in", as the oracle's own comment puts it — grants nothing. */
async function member(
  seed: Seed,
  over: Partial<{ kind: string; tier: string; status: string; is_connector: boolean }> = {}
): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: over.status ?? "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

async function group(seed: Seed, over: { slug?: string; isBuiltin?: boolean } = {}): Promise<string> {
  const { data, error } = await db()
    .from("groups")
    .insert({
      team_id: seed.teamId,
      slug: over.slug ?? `g-${randomUUID().slice(0, 8)}`,
      name: "fixture group",
      is_builtin: over.isBuiltin ?? false,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed group failed: ${error?.message}`);
  return data.id as string;
}

/** A BUILT-IN group with a sanctioned slug, reusing the team's existing row when bootstrap made one. */
async function builtinGroup(seed: Seed, slug: string): Promise<string> {
  const { data: existing } = await db()
    .from("groups")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    await db().from("groups").update({ is_builtin: true }).eq("id", existing.id);
    return existing.id as string;
  }
  return group(seed, { slug, isBuiltin: true });
}

async function join(seed: Seed, groupId: string, memberId: string): Promise<void> {
  const { error } = await db().from("group_members").insert({ team_id: seed.teamId, group_id: groupId, member_id: memberId });
  if (error) throw new Error(`seed group_members failed: ${error.message}`);
}

async function project(seed: Seed, kind = "source"): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 8)}`, name: "fixture", kind })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  return data.id as string;
}

async function grant(seed: Seed, projectId: string, groupId: string): Promise<void> {
  const { error } = await db().from("project_groups").insert({ team_id: seed.teamId, project_id: projectId, group_id: groupId });
  if (error) throw new Error(`seed grant failed: ${error.message}`);
}

/**
 * Build an item whose ONLY route to a reader is the (project, group, member) triple described, and
 * return whether the predicate calls it unreachable.
 *
 * The item is placed in `projectId` alone — deliberately NOT bootstrapped into `general`, because an
 * item that is also in General is reachable through `everyone` and the fixture would prove nothing
 * about the clause under test. (One condition per fixture: this program has twice had a fixture that
 * tripped two rules and therefore pinned only the first.)
 */
async function isolatedItem(seed: Seed, projectId: string, path: string): Promise<string> {
  const { id: itemId } = await ingest(seed, { path, body: path, access: "team", project: "src" });
  const { data: unit, error: uErr } = await db()
    .from("project_context_units")
    .insert({
      team_id: seed.teamId,
      unit_kind: "item",
      source_item_id: itemId,
      unit_key: `item:${itemId}`,
      audience: "team",
      content_sha256: "0".repeat(64),
      state: "active",
    })
    .select("id")
    .single();
  if (uErr || !unit) throw new Error(`seed unit failed: ${uErr?.message}`);
  const { error: mErr } = await db()
    .from("project_context_memberships")
    .insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: unit.id, decision: "include", mode: "auto", method: "rule" });
  if (mErr) throw new Error(`seed membership failed: ${mErr.message}`);
  return itemId;
}

/**
 * Is THIS item reported unreachable? Asked of the shipped reader, so the criterion pins the contract
 * the CLI and `assessAccessHealth` actually consume.
 *
 * ⚠️ The first version returned `examples.includes(path) || count > 0`, which answers "is ANYTHING
 * unreachable" — so the two criteria expecting REACHABLE (AC2a, AC6) failed on an unrelated item the
 * fixture team happened to leave unpartitioned. It reddened, which looked like the defect, and was
 * the fixture asking the wrong question. Per-path only.
 */
async function unreachable(seed: Seed, path: string): Promise<boolean> {
  const r = await findUnpartitionedItems(db(), seed.teamId);
  expect(r.truncated, "fixture too large to reason about by example").toBe(false);
  expect(r.count, "fixture should be small enough that examples is not itself truncated").toBeLessThanOrEqual(5);
  return r.examples.includes(path);
}

describe("AUDITFIX-15A — universal reachability, the oracle's rule and nothing else", () => {
  it("AC1 — a project granted ONLY to an EMPTY group is UNREACHABLE (the shipped predicate's defect)", async () => {
    const seed = await seedTeam();
    const p = await project(seed);
    await grant(seed, p, await group(seed)); // granted, but nobody is in the group
    await isolatedItem(seed, p, "ac1.md");
    expect(await unreachable(seed, "ac1.md"), "a grant to a group nobody is in reaches nobody").toBe(true);
  });

  it("AC2a — an AGENT in a CUSTOM granted group is REACHABLE (oracle.ts:84-95: custom groups admit agents)", async () => {
    const seed = await seedTeam();
    const p = await project(seed);
    const g = await group(seed, { isBuiltin: false });
    await join(seed, g, await member(seed, { kind: "agent" }));
    await grant(seed, p, g);
    await isolatedItem(seed, p, "ac2a.md");
    expect(await unreachable(seed, "ac2a.md")).toBe(false);
  });

  it("AC2b — the SAME agent in a BUILT-IN granted group is UNREACHABLE (isBuiltinEligible: humans only)", async () => {
    const seed = await seedTeam();
    const p = await project(seed);
    // The team may already carry an `everyone` row; this fixture needs its OWN builtin group with a
    // SANCTIONED slug, so it uses `external` — the other slug isBuiltinEligible admits — created only
    // if absent.
    const g = await builtinGroup(seed, "external");
    await join(seed, g, await member(seed, { kind: "agent" }));
    await grant(seed, p, g);
    await isolatedItem(seed, p, "ac2b.md");
    expect(await unreachable(seed, "ac2b.md"), "agents are never auto-admitted by a builtin").toBe(true);
  });

  it("AC3 — a BUILT-IN group with an UNKNOWN slug is inert, even holding an eligible human", async () => {
    const seed = await seedTeam();
    const p = await project(seed);
    const g = await group(seed, { slug: `squat-${randomUUID().slice(0, 6)}`, isBuiltin: true });
    await join(seed, g, await member(seed));
    await grant(seed, p, g);
    await isolatedItem(seed, p, "ac3.md");
    expect(await unreachable(seed, "ac3.md"), "unknown builtin slug fails closed").toBe(true);
  });

  for (const [label, over] of [
    ["a CONNECTOR", { is_connector: true }],
    ["an OFFROSTER row", { kind: "offroster" }],
    ["a DISABLED human", { status: "disabled" }],
  ] as const) {
    it(`AC4 — a granted group holding only ${label} is UNREACHABLE`, async () => {
      const seed = await seedTeam();
      const p = await project(seed);
      const g = await group(seed);
      await join(seed, g, await member(seed, over));
      await grant(seed, p, g);
      const path = `ac4-${label.replace(/\W+/g, "")}.md`;
      await isolatedItem(seed, p, path);
      expect(await unreachable(seed, path)).toBe(true);
    });
  }

  // AC5 — the SERVING conjuncts. Omitted from the first implementation of this file even though the
  // spec listed it, and two mutations SURVIVED as a result: deleting `u.state = 'active'` and
  // deleting `pcm.decision = 'include'` each reddened nothing. A criterion that exists only in prose
  // pins nothing.
  for (const [label, unitOver, memOver] of [
    ["a RETRACTED unit", { state: "retracted" }, {}],
    ["an EXCLUDE membership", {}, { decision: "exclude" }],
    ["a CLOSED membership", {}, { valid_to: new Date().toISOString() }],
  ] as const) {
    it(`AC5 — ${label} is UNREACHABLE`, async () => {
      const seed = await seedTeam();
      const p = await project(seed);
      const g = await group(seed);
      await join(seed, g, await member(seed));
      await grant(seed, p, g);
      const path = `ac5-${label.replace(/\W+/g, "")}.md`;
      const { id: itemId } = await ingest(seed, { path, body: path, access: "team", project: "src" });
      const { data: unit, error: uErr } = await db()
        .from("project_context_units")
        .insert({
          team_id: seed.teamId, unit_kind: "item", source_item_id: itemId, unit_key: `item:${itemId}`,
          audience: "team", content_sha256: "0".repeat(64), state: "active", ...unitOver,
        })
        .select("id")
        .single();
      if (uErr || !unit) throw new Error(`seed unit failed: ${uErr?.message}`);
      const { error: mErr } = await db()
        .from("project_context_memberships")
        .insert({
          team_id: seed.teamId, project_id: p, context_unit_id: unit.id,
          decision: "include", mode: "auto", method: "rule", ...memOver,
        });
      if (mErr) throw new Error(`seed membership failed: ${mErr.message}`);
      expect(await unreachable(seed, path)).toBe(true);
    });
  }

  it("AC6 — tier, project kind and membership mode are NOT serving conjuncts", async () => {
    const seed = await seedTeam();
    const p = await project(seed, "initiative"); // kind is not consulted by the oracle
    const g = await group(seed);
    await join(seed, g, await member(seed, { tier: "external" })); // tier is not re-evaluated
    await grant(seed, p, g);
    const { id: itemId } = await ingest(seed, { path: "ac6.md", body: "ac6", access: "team", project: "src" });
    const { data: unit } = await db()
      .from("project_context_units")
      .insert({
        team_id: seed.teamId, unit_kind: "item", source_item_id: itemId, unit_key: `item:${itemId}`,
        audience: "team", content_sha256: "0".repeat(64), state: "active",
      })
      .select("id")
      .single();
    await db()
      .from("project_context_memberships")
      .insert({ team_id: seed.teamId, project_id: p, context_unit_id: unit!.id, decision: "include", mode: "force_include", method: "manual" });
    expect(await unreachable(seed, "ac6.md"), "adding a 'safety' filter here silently narrows reachability").toBe(false);
  });

  it("AC7 — the healthy control: a normally-bootstrapped team reports ZERO unreachable", async () => {
    // Without this, a predicate that flagged EVERYTHING would satisfy AC1-AC6.
    const seed = await seedTeam();
    await ingest(seed, { path: "ac7.md", body: "ac7", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const b = await backfillTeamContext(db(), seed.teamId);
    expect(b.ok, b.error).toBe(true);
    const r = await findUnpartitionedItems(db(), seed.teamId);
    expect(r.count, r.examples.join(", ")).toBe(0);
  });
});
