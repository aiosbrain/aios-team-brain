import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { db, ingest, seedTeam, sha } from "./helpers";

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

describe("B1: an unchanged re-push heals items.access and cascades to tasks (real Postgres)", () => {
  // Regression for the Pass-1 tier-leak blocker. The unchanged fast-path (identical content_sha256)
  // used to write only { synced_at, member_id?, frontmatter? } — never `access`. So a source that
  // RECLASSIFIES an item's tier WITHOUT editing its prose kept the first-ingest `access` forever, and
  // with no RLS backstop (CLAUDE.md §5) every read path kept serving the now-restricted body at the
  // old tier. The security-critical direction is external → team (an externally-shared doc pulled back
  // internal that stays visible to external principals).
  it("external → team narrowing on an IDENTICAL re-push heals items.access to 'team'", async () => {
    const seed = await seedTeam();
    const body = "the same body, reclassified upstream without an edit";
    const first = await ingest(seed, { path: "reclass.md", kind: "deliverable", body, access: "external" });
    expect(first.status).toBe("created");

    const second = await ingest(seed, { path: "reclass.md", kind: "deliverable", body, access: "team" });
    expect(second.status).toBe("unchanged"); // identical sha → the fast path, no re-materialization

    const { data } = await db().from("items").select("access").eq("id", first.id).single();
    expect((data as { access: string }).access).toBe("team");
  });

  it("cascades the healed tier onto tasks materialized from the item (tasks.audience)", async () => {
    const seed = await seedTeam();
    const body = "| row_key | title |\n|---|---|\n| T-9 | shared then pulled back |";
    const rows = [{ row_key: "T-9", title: "shared then pulled back" }];
    const first = await ingest(seed, { path: "reclass-board.md", kind: "task", body, access: "external", rows });
    expect(first.status).toBe("created");
    // Identical body+rows → identical sha → unchanged path (materialize does NOT run); only access changes.
    const second = await ingest(seed, { path: "reclass-board.md", kind: "task", body, access: "team", rows });
    expect(second.status).toBe("unchanged");

    const { data } = await db()
      .from("tasks")
      .select("audience")
      .eq("team_id", seed.teamId)
      .eq("row_key", "T-9")
      .single();
    expect((data as { audience: string }).audience).toBe("team");
  });

  it("team → external widening on an identical re-push also heals items.access", async () => {
    const seed = await seedTeam();
    const body = "internal doc later shared with the client, no edit";
    const first = await ingest(seed, { path: "widen.md", kind: "deliverable", body, access: "team" });
    await ingest(seed, { path: "widen.md", kind: "deliverable", body, access: "external" });
    const { data } = await db().from("items").select("access").eq("id", first.id).single();
    expect((data as { access: string }).access).toBe("external");
  });

  it("SECURITY: an external-tier pusher CANNOT widen a team item's access via an identical re-push", async () => {
    // The downgrade-attack the trust gate closes: the access-heal must trust ONLY a team-tier pusher.
    // An external key that knows a team item's path + body could otherwise re-push it (identical sha →
    // unchanged path) with access='external' and flip the real team content to externally-visible.
    const seed = await seedTeam();
    const body = "internal team doc whose path + body an external key happens to know";
    const first = await ingest(seed, { path: "target.md", kind: "deliverable", body, access: "team" });
    expect(first.status).toBe("created");

    // Re-push as an EXTERNAL-tier principal (pusherTier = "external") attempting to widen to external.
    const attack = await ingestItem(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      {
        project: "acme",
        kind: "deliverable",
        actor: "attacker",
        frontmatter: {},
        path: "target.md",
        body,
        access: "external",
        content_sha256: sha(body),
      } as ItemPayload,
      "external",
      undefined,
      "external"
    );
    expect(attack.status).toBe("unchanged");

    const { data } = await db().from("items").select("access").eq("id", first.id).single();
    expect((data as { access: string }).access).toBe("team"); // refused — NOT widened
  });

  it("leaves access untouched when an identical re-push keeps the same tier (no needless write)", async () => {
    const seed = await seedTeam();
    const body = "stable internal doc";
    const first = await ingest(seed, { path: "stable.md", kind: "deliverable", body, access: "team" });
    const second = await ingest(seed, { path: "stable.md", kind: "deliverable", body, access: "team" });
    expect(second.status).toBe("unchanged");
    const { data } = await db().from("items").select("access").eq("id", first.id).single();
    expect((data as { access: string }).access).toBe("team");
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
