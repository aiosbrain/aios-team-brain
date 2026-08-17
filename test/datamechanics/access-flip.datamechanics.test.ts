import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { retrieve } from "@/lib/query/retrieve";
import { visibleItemIds } from "@/lib/access/enforce";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { runSql } from "@/lib/db/pg/pool";
import {
  autoFlipIfReady,
  readAccessEnforcement,
  setAccessEnforcement,
} from "@/lib/admin/access-enforcement";
import { runAutoFlipPass } from "@/lib/admin/auto-flip-pass";

/**
 * PRET-2 — the UNATTENDED flip path (spec docs/design/pret2-convergence-gated-flip.md §2;
 * program docs/design/retire-permissive-model.md §4). The manual path's proofs live in
 * access-enforcement-flip.datamechanics.test.ts; this file proves what the scheduler may do
 * WITHOUT a human: flip only warning-free, un-held, ready teams; defer everything else loudly,
 * exactly once per distinct state; and never abort the fleet for one team's error.
 */

const TERM = "cranberrywood"; // rare term so FTS grounds the item legs deterministically

async function seedMember(seed: Seed, over: { tier?: string; kind?: string; is_connector?: boolean } = {}): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "M",
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      kind: over.kind ?? "human",
      is_connector: over.is_connector ?? false,
      status: "active",
    })
    .select("id")
    .single();
  return data!.id as string;
}

async function deferralRows(teamId: string): Promise<Array<{ meta: Record<string, unknown> }>> {
  const r = await runSql<{ meta: Record<string, unknown> }>(
    "select meta from audit_log where team_id = $1 and action = 'access.autoflip_deferred' order by created_at asc",
    [teamId]
  );
  return r.rows;
}

async function itemLegPaths(seed: Seed, memberId: string | null): Promise<string[]> {
  // Pre-flip the routes pass enforce = null (permissive); post-flip, the member arm.
  const enforce = memberId
    ? { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId })).ids, principal: "member" as const }
    : null;
  const ctx = await retrieve(db(), seed.teamId, "team", `tell me about ${TERM}`, null, enforce);
  return ctx.sources.map((s) => s.path).sort();
}

describe("PRET-2 — a ready, warning-free team auto-flips with byte-identical item legs (criterion 1)", () => {
  it("autoFlipIfReady flips and the FTS/recency item sources are identical pre/post", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "a.md", body: `alpha ${TERM}`, access: "team", project: "src" });
    await ingest(seed, { path: "b.md", body: `beta ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);

    const pre = await itemLegPaths(seed, null); // permissive read: enforce is null
    const r = await autoFlipIfReady(db(), seed.teamId);
    expect(r.flipped, JSON.stringify(r.deferred)).toBe(true);
    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("enforcing");

    // seedTeam's own member — group-synced by the bootstrap, so their oracle resolves General.
    const post = await itemLegPaths(seed, seed.memberId); // enforced read: oracle member arm
    // The §11 byte-identical promise, scoped to the legs it governs (spec §2.1): the ITEM-LEG
    // sources. The structured legs differ by design post-flip (aggregates omitted, rels
    // narrowed, graph partition-served) and are NOT asserted equal here.
    expect(post).toEqual(pre);
  });
});

describe("PRET-2 — blockers defer, exactly once per distinct state (criterion 2 + the latch)", () => {
  it("an unhealable prepare refusal (reserved-slug hijack) blocks the flip; the deferral is audited ONCE across repeated attempts", async () => {
    // The prepare inside the flip HEALS everything routine — ensureBuiltins ends with
    // syncBuiltinMembership, so even a raw-inserted blind human is re-sighted before the
    // assessment (this fixture originally seeded one and watched the machinery heal it). The
    // deterministic UNHEALABLE state is the reserved-slug hijack: a non-builtin group squatting
    // 'everyone' makes the bootstrap REFUSE by design until a human intervenes.
    const seed = await seedTeam();
    await ingest(seed, { path: "u.md", body: `squat ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await runSql("update groups set is_builtin = false where team_id = $1 and slug = 'everyone'", [seed.teamId]);

    const r1 = await autoFlipIfReady(db(), seed.teamId);
    expect(r1.flipped).toBe(false);
    expect(r1.deferred?.blockers.join(" ")).toContain("reserved slug");
    const r2 = await autoFlipIfReady(db(), seed.teamId);
    expect(r2.flipped).toBe(false);

    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("permissive");
    const rows = await deferralRows(seed.teamId);
    expect(rows.length, "one deferral row per DISTINCT state, not per attempt (the fingerprint latch)").toBe(1);
    expect(JSON.stringify(rows[0].meta)).toContain("reserved slug");
  });
});

describe("PRET-2 — warnings defer BEFORE any drain; manual flip still works (criterion 3)", () => {
  it("an active connector defers the auto-flip with the warning audited; setAccessEnforcement succeeds manually", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "c.md", body: `connector ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await seedMember(seed, { is_connector: true });

    const r = await autoFlipIfReady(db(), seed.teamId);
    expect(r.flipped).toBe(false);
    expect(r.deferred?.warnings.join(" "), "the connector warning reaches the deferral").toContain("connector");
    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("permissive");
    const rows = await deferralRows(seed.teamId);
    expect(rows.length).toBe(1);

    // The narrowing gates ONLY the unattended path: a human flipping manually proceeds
    // (warnings are informational for a human, access-enforcement.ts gates on `ready` alone).
    const manual = await setAccessEnforcement(db(), seed.teamId, "enforcing");
    expect(manual.ok).toBe(true);
    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("enforcing");
  });
});

describe("PRET-2 — error containment, idempotency, and the operator-undo hold (criterion 4)", () => {
  it("an induced error defers (never throws), an enforcing team no-ops with no audit row", async () => {
    // A nonexistent team makes the mode read throw inside — autoFlipIfReady must contain it.
    const ghost = randomUUID();
    const r = await autoFlipIfReady(db(), ghost);
    expect(r.flipped).toBe(false);
    expect(r.deferred?.error, "the throw is contained into the result").toBeTruthy();

    const seed = await seedTeam();
    await ingest(seed, { path: "i.md", body: `idem ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const first = await autoFlipIfReady(db(), seed.teamId);
    expect(first.flipped).toBe(true);
    const before = (await deferralRows(seed.teamId)).length;
    const again = await autoFlipIfReady(db(), seed.teamId);
    expect(again.flipped).toBe(false);
    expect(again.deferred, "already-enforcing is a silent no-op, not a deferral").toBeUndefined();
    expect((await deferralRows(seed.teamId)).length).toBe(before);
  });

  it("a member-attributed downgrade HOLDS the team out of auto-flip; a system downgrade does not", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "h.md", body: `held ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);

    expect((await autoFlipIfReady(db(), seed.teamId)).flipped).toBe(true);
    // The operator's one-command undo — member-attributed (seedTeam's member: group-synced,
    // so no blind-human blocker muddies this fixture — one condition per fixture).
    const undo = await setAccessEnforcement(db(), seed.teamId, "permissive", { actorMemberId: seed.memberId });
    expect(undo.ok).toBe(true);

    const r = await autoFlipIfReady(db(), seed.teamId);
    expect(r.flipped, "the undo is not a 30-minute lease").toBe(false);
    expect(await readAccessEnforcement(db(), seed.teamId)).toBe("permissive");

    // A SYSTEM-attributed downgrade (no operator intent) does not hold.
    const sys = await setAccessEnforcement(db(), seed.teamId, "enforcing");
    expect(sys.ok).toBe(true);
    const sysDown = await setAccessEnforcement(db(), seed.teamId, "permissive");
    expect(sysDown.ok).toBe(true);
    const r2 = await autoFlipIfReady(db(), seed.teamId);
    expect(r2.flipped, "system-attributed history never excludes").toBe(true);
  });
});

describe("PRET-2 — the pass is rate-limited and per-team contained (criterion 5)", () => {
  it("five ready teams: one pass flips exactly 3, the next flips the remaining 2", async () => {
    const seeds: Seed[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await seedTeam();
      await ingest(s, { path: "p.md", body: `pass ${TERM}`, access: "team", project: "src" });
      await backfillTeamContext(db(), s.teamId);
      seeds.push(s);
    }
    const ids = new Set(seeds.map((s) => s.teamId));
    const one = await runAutoFlipPass(db());
    const flippedOne = one.flipped.filter((t) => ids.has(t));
    // EXACT (the rate limit is the pin — a band would pass a budget bug): 3 of OUR five.
    expect(flippedOne.length).toBe(3);

    const two = await runAutoFlipPass(db());
    const flippedTwo = two.flipped.filter((t) => ids.has(t));
    expect(flippedTwo.length).toBe(2);
    for (const s of seeds) expect(await readAccessEnforcement(db(), s.teamId)).toBe("enforcing");
  });
});
