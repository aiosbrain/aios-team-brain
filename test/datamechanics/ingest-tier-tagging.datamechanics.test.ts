import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec: `lib/ingest` materializes each task/decision row's tier onto a real `access_tier`
 * Postgres enum column (`tasks.audience` / `decisions.audience`) — the value the dashboard's
 * `visibleTasks`/`visibleDecisions` choke-point (lib/auth/visibility.ts) later filters on. There
 * is no RLS, so a wrong or missing tier tag here is invisible until read time. Verified against
 * the real DB (the enum itself is a backstop against a garbage tier value ever landing in the
 * column at all — but NOT against a wrongly-computed team/external mapping, which is what these
 * tests check).
 */

describe("tasks.audience inherits the item's access tier (real Postgres)", () => {
  it("access='external' materializes tasks.audience='external'", async () => {
    const seed = await seedTeam();
    const body = "| row_key | title |\n|---|---|\n| T-1 | client task |";
    await ingest(seed, {
      path: "client-board.md",
      kind: "task",
      body,
      access: "external",
      rows: [{ row_key: "T-1", title: "client task" }],
    });

    const { data } = await db()
      .from("tasks")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-1")
      .single();
    expect((data as { audience: string }).audience).toBe("external");
  });

  it("access='team' materializes tasks.audience='team'", async () => {
    const seed = await seedTeam();
    const body = "| row_key | title |\n|---|---|\n| T-2 | internal task |";
    await ingest(seed, {
      path: "internal-board.md",
      kind: "task",
      body,
      access: "team",
      rows: [{ row_key: "T-2", title: "internal task" }],
    });

    const { data } = await db()
      .from("tasks")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-2")
      .single();
    expect((data as { audience: string }).audience).toBe("team");
  });

  it("changing the item's access on a later push re-tags the task's audience on the next materialization", async () => {
    const seed = await seedTeam();
    const body1 = "| row_key | title |\n|---|---|\n| T-3 | internal for now |";
    await ingest(seed, {
      path: "reclassified.md",
      kind: "task",
      body: body1,
      access: "team",
      rows: [{ row_key: "T-3", title: "internal for now" }],
    });
    const { data: before } = await db()
      .from("tasks")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-3")
      .single();
    expect((before as { audience: string }).audience).toBe("team");

    const body2 = "| row_key | title |\n|---|---|\n| T-3 | now shared with client |";
    await ingest(seed, {
      path: "reclassified.md",
      kind: "task",
      body: body2,
      access: "external",
      rows: [{ row_key: "T-3", title: "now shared with client" }],
    });
    const { data: after } = await db()
      .from("tasks")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-3")
      .single();
    expect((after as { audience: string }).audience).toBe("external");
  });
});

describe("decisions.audience is independent of the item's access tier (real Postgres) — see PR notes", () => {
  // SURPRISING (report, don't fix): materializeDecisions() never receives the item's `access` —
  // each row's audience comes solely from decisionRowSchema's own `audience` field (default
  // "team"). This is a real asymmetry with tasks (which DO inherit `access`). Not a leak (it
  // under-shares, defaulting more restrictive), but a correctness inconsistency worth a follow-up.
  it("an external-access item's decision row with no explicit audience column materializes as audience='team' (NOT inherited)", async () => {
    const seed = await seedTeam();
    const body = "| row_key | title |\n|---|---|\n| D-1 | no audience column |";
    await ingest(seed, {
      path: "external-decisions.md",
      kind: "decision",
      body,
      access: "external",
      rows: [{ row_key: "D-1", title: "no audience column" }],
    });

    const { data } = await db()
      .from("decisions")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "D-1")
      .single();
    expect((data as { audience: string }).audience).toBe("team");
  });

  it("a team-access item's decision row CAN opt a single row into audience='external' via its own field", async () => {
    const seed = await seedTeam();
    const body = "| row_key | title | audience |\n|---|---|---|\n| D-2 | opts into external | external |";
    await ingest(seed, {
      path: "team-decisions.md",
      kind: "decision",
      body,
      access: "team",
      rows: [{ row_key: "D-2", title: "opts into external", audience: "external" }],
    });

    const { data } = await db()
      .from("decisions")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "D-2")
      .single();
    expect((data as { audience: string }).audience).toBe("external");
  });
});
