import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { retrieve, type RetrieveEnforce } from "@/lib/query/retrieve";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds } from "@/lib/access/enforce";

/**
 * QMIR-1 (design docs/design/query-mirror-legs-classification.md §5, criteria 1-3): the
 * graph-mirror query legs are TIER-classed, not partition-classed. An enforcing TEAM-tier
 * member regains the ORG-STRUCTURAL legs (actors + REPORTS_TO), through the type allowlist;
 * tokens, default-deny arms, and the external tier keep the fail-closed omission of all three
 * legs. Spec-first against real Postgres — the population criterion 1 names is exactly the one
 * that loses the legs today.
 */

const TERM = "quincewood"; // rare term so FTS grounds the item legs deterministically

async function seedMember(seed: Seed): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return data!.id as string;
}

/** Seed the org-structural rows (the real writer's shapes) + the item-derived plants (the
 *  allowlist's targets). One fixture per concern would hide allowlist interactions — this file's
 *  tests each assert BOTH directions on the same seeded state. */
async function seedGraphRows(seed: Seed): Promise<void> {
  const rows = [
    { entity_type: "actor", entity_id: "member:alice", name: "Alice Chen", attrs: { member_role: "admin" } },
    { entity_type: "actor", entity_id: "member:bob", name: "Bob Osei", attrs: { member_role: "member" } },
    { entity_type: "commitment", entity_id: "c-widget", name: "ship the widget", attrs: { status: "open" } },
  ];
  for (const r of rows) {
    const { error } = await db().from("graph_entities").insert({ team_id: seed.teamId, ...r });
    expect(error).toBeNull();
  }
  const edges = [
    { from_id: "member:bob", to_id: "member:alice", relationship_type: "REPORTS_TO" },
    { from_id: "member:alice", to_id: "c-widget", relationship_type: "OWNS" },
  ];
  for (const e of edges) {
    const { error } = await db().from("graph_relationships").insert({ team_id: seed.teamId, ...e });
    expect(error).toBeNull();
  }
}

async function enforcingMember(seed: Seed): Promise<RetrieveEnforce> {
  const member = await seedMember(seed);
  const { ids } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });
  return { visibleItemIds: ids, principal: "member" };
}

describe("QMIR-1 — an enforcing team-tier member regains the org-structural legs (criterion 1)", () => {
  it("the enforcing context contains the actor roster and the REPORTS_TO edge", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);

    const ctx = await retrieve(db(), seed.teamId, "team", "who reports to whom?", null, await enforcingMember(seed));
    expect(ctx.structured, "the roster reaches the enforcing member").toContain("Alice Chen");
    expect(ctx.structured).toContain("Bob Osei");
    expect(ctx.structured, "the org edge reaches the enforcing member").toContain("member:bob REPORTS_TO member:alice");
  });

  it("the abstention note stays soft: a roster answer from structured context is permitted (criterion 1, cold-read L3)", async () => {
    // A pure roster question grounds on no items (grounded=false) — the note must keep allowing
    // the structured context to answer, else criterion 1's contents never reach the user.
    const { groundingNote } = await import("@/lib/query/claude");
    const note = groundingNote(false);
    expect(note).toContain("structured context");
    expect(note, "the note forbids answering only when BOTH sources and structured context lack it").toContain("neither");
  });
});

describe("QMIR-1 — a departed member's edges do not render (Codex Medium 1)", () => {
  it("a disabled actor's REPORTS_TO edge is dropped alongside the actor; the active pair's edge survives", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);
    // The REAL writer's soft-disable shape: the actor row is kept with attrs.status = "disabled"
    // (lib/graph/company-actors.ts) — the fixture must carry it, or this test misses the
    // lifecycle the finding is about.
    const { error: e1 } = await db().from("graph_entities").insert({
      team_id: seed.teamId, entity_type: "actor", entity_id: "member:departed",
      name: "Dana Departed", attrs: { member_role: "member", status: "disabled" },
    });
    expect(e1).toBeNull();
    const { error: e2 } = await db().from("graph_relationships").insert({
      team_id: seed.teamId, from_id: "member:departed", to_id: "member:alice", relationship_type: "REPORTS_TO",
    });
    expect(e2).toBeNull();

    const ctx = await retrieve(db(), seed.teamId, "team", "who reports to whom?", null, await enforcingMember(seed));
    expect(ctx.structured, "the departed person is not cited").not.toContain("Dana Departed");
    expect(ctx.structured, "their edge is not cited either — the actor filter alone left it").not.toContain("member:departed REPORTS_TO");
    expect(ctx.structured, "the active pair's edge survives the filter").toContain("member:bob REPORTS_TO member:alice");
  });
});

describe("QMIR-1 — the type allowlist holds (criterion 2; PRET-6: one mode)", () => {
  it("a planted commitment and a planted OWNS edge never reach a member — the allowlist is actors + REPORTS_TO, flat", async () => {
    // The PERMISSIVE control half ("commitments reach a permissive member exactly as today")
    // deleted WITH its mode (PRET-6): the permissive triple and its carve-outs are gone; the
    // allowlist closure is now the whole property, with the served legs as the positive control.
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);

    const enforcing = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, await enforcingMember(seed));
    expect(enforcing.structured, "positive control: the org-structural legs serve").toContain("Alice Chen");
    expect(enforcing.structured, "no production writer mints commitments — omitted for everyone").not.toContain("ship the widget");
    expect(enforcing.structured, "OWNS is not org-structural — the rels allowlist is REPORTS_TO only").not.toContain("OWNS c-widget");
  });
});

describe("QMIR-1 — tokens, default-deny arms, and the external tier keep the omission (criterion 3)", () => {
  it("a token read, a principal-ABSENT payload, and an UNRECOGNIZED principal each get none of the three legs", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);
    const member = await seedMember(seed);
    const { ids } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });

    const arms: Array<[string, RetrieveEnforce]> = [
      ["token", { visibleItemIds: ids, principal: "token" }],
      // The default-deny arms (design §3.1): absence and a foreign value must take token semantics.
      ["absent", { visibleItemIds: ids } as unknown as RetrieveEnforce],
      ["foreign", { visibleItemIds: ids, principal: "supervisor" } as unknown as RetrieveEnforce],
    ];
    for (const [label, enforce] of arms) {
      const ctx = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, enforce);
      expect(ctx.structured, `${label}: no actors`).not.toContain("Alice Chen");
      expect(ctx.structured, `${label}: no relationships`).not.toContain("REPORTS_TO member:alice");
      expect(ctx.structured, `${label}: no commitments`).not.toContain("ship the widget");
    }
  });

  // Deleted WITH its subject (PRET-6): "a PERMISSIVE external-posture read gets actors +
  // REPORTS_TO" — the permissive read is gone; its surviving property (structure serves the
  // external member, commitments/OWNS stay closed) is exactly the ENFORCING-external arm below.
  it("an EXTERNAL member — the combination the routes actually produce — gets actors + REPORTS_TO, commitments closed (PRET-4 inverts review Medium 2)", async () => {
    // This arm was BUILT to catch the exact gate rewrite PRET-4 now makes deliberately (the
    // tier disjunct's removal from the org legs) — inverted, not deleted: the org chart serves
    // every member principal; the commitments allowlist closure is what still holds.
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: `x ${TERM}`, access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);
    const member = await seedMember(seed);
    const { ids } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });

    const ctx = await retrieve(db(), seed.teamId, "external", `about ${TERM}`, null, { visibleItemIds: ids, principal: "member" });
    expect(ctx.structured, "structure serves the enforcing external member (ruling 2's roster half)").toContain("Alice Chen");
    expect(ctx.structured).toContain("REPORTS_TO");
    expect(ctx.structured, "commitments stay allowlist-closed for every enforcing principal").not.toContain("ship the widget");
  });
});
