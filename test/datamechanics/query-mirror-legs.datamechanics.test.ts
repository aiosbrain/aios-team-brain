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

describe("QMIR-1 — the type allowlist holds under enforcing (criterion 2)", () => {
  it("a planted commitment and a planted OWNS edge reach a PERMISSIVE member but NOT an enforcing one", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);

    const permissive = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, null);
    expect(permissive.structured, "permissive serves commitments exactly as today").toContain("ship the widget");
    expect(permissive.structured, "permissive serves the OWNS edge exactly as today").toContain("member:alice OWNS c-widget");

    const enforcing = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, await enforcingMember(seed));
    expect(enforcing.structured, "no production writer mints commitments — enforcing omits them").not.toContain("ship the widget");
    expect(enforcing.structured, "OWNS is not org-structural — the enforcing rels allowlist is REPORTS_TO only").not.toContain("OWNS c-widget");
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

  it("an external-tier read gets none of the three legs (unchanged audit-H1 posture)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: `x ${TERM}`, access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedGraphRows(seed);

    const ctx = await retrieve(db(), seed.teamId, "external", `about ${TERM}`, null, null);
    expect(ctx.structured).not.toContain("Alice Chen");
    expect(ctx.structured).not.toContain("REPORTS_TO");
    expect(ctx.structured).not.toContain("ship the widget");
  });
});
