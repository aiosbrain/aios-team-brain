import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AUDITFIX-19 AC-04/AC-05 — the action's visibility-read seam, exercised from TESTS ONLY.
 *
 * `visibleProjectRows` is replaced by a module mock that passes through to the ORIGINAL by default.
 * A hoisted, resettable switch can (a) make one leg's lookup report a read error, or (b) hold every
 * lookup on a deferred promise so the test can mutate the caller's original request object while the
 * action is suspended. Nothing in production takes a test parameter, option or environment hook.
 *
 * Secret hygiene: outcomes are reduced to booleans and the refusal to an exact non-secret rule
 * comparison; no bearer, hash or raw error string is passed to an assertion.
 */

const seam = vi.hoisted(() => ({
  errorFor: null as string | null,
  gate: null as Promise<void> | null,
  onReached: null as (() => void) | null,
  calls: [] as string[],
}));

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));
vi.mock("@/lib/access/enforce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/access/enforce")>();
  return {
    ...actual,
    visibleProjectRows: vi.fn(async (...args: Parameters<typeof actual.visibleProjectRows>) => {
      const [, principal] = args;
      seam.calls.push(principal.memberId);
      if (seam.errorFor !== null && principal.memberId === seam.errorFor) {
        return { ids: new Set<string>(), error: true };
      }
      if (seam.gate) {
        seam.onReached?.();
        await seam.gate;
      }
      return actual.visibleProjectRows(...args);
    }),
  };
});

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import type { MintResult } from "@/lib/access/agent-tokens";
import type { MintRequest } from "@/lib/access/agent-token-policy";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";

const SLUG = "auditfix19-seams";
const LOOKUP_ERROR = "could not verify project visibility for scope.projectIds — try again";

function resetSeam(): void {
  seam.errorFor = null;
  seam.gate = null;
  seam.onReached = null;
  seam.calls = [];
}

async function seedMember(seed: Seed, kind: "human" | "agent"): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "team",
      status: "active",
      kind,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

/** A project genuinely granted (via a fresh group each) to every listed member — no hand-entered rows. */
async function projectGrantedTo(seed: Seed, members: string[]): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `s-${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  for (const m of members) {
    const g = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 6)}`, "g", seed.memberId);
    if (!g.ok) throw new Error(`create group failed: ${g.error}`);
    if (!(await addMemberToGroup(db(), seed.teamId, g.groupId!, m, seed.memberId)).ok) throw new Error("add member failed");
    if (!(await grantProjectToGroup(db(), seed.teamId, data.id as string, g.groupId!, seed.memberId)).ok) throw new Error("grant failed");
  }
  return data.id as string;
}

/** Genuine team-posture admin A (seeded human in Everyone, promoted) + distinct eligible launcher L. */
async function harness(): Promise<{ seed: Seed; admin: string; launcher: string }> {
  const seed = await seedTeam();
  const { error } = await db().from("members").update({ role: "admin" }).eq("team_id", seed.teamId).eq("id", seed.memberId);
  if (error) throw new Error(`promote admin failed: ${error.message}`);
  const launcher = await seedMember(seed, "agent");
  vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: seed.memberId });
  return { seed, admin: seed.memberId, launcher };
}

async function counts(teamId: string): Promise<{ tokens: number; audits: number }> {
  const t = await db().from("agent_tokens").select("id").eq("team_id", teamId);
  const a = await db().from("audit_log").select("id").eq("team_id", teamId).eq("action", "access.token_minted");
  if (t.error || a.error) throw new Error("count read failed");
  return { tokens: (t.data ?? []).length, audits: (a.data ?? []).length };
}

function view(res: MintResult): { ok: boolean; hasToken: boolean; hasRowId: boolean } {
  return { ok: res.ok, hasToken: res.token !== undefined, hasRowId: res.tokenRowId !== undefined };
}

function future(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

describe("AUDITFIX-19 AC-05 — a visibility lookup ERROR fails closed (test-injected), paired with the same uninjected input succeeding", () => {
  beforeEach(() => {
    resetSeam();
    vi.mocked(requireTeamAdmin).mockReset();
  });

  for (const leg of ["admin", "launcher"] as const) {
    it(`an injected ${leg}-leg lookup error refuses with no token/id/row/audit; the same input then mints`, async () => {
      const { seed, admin, launcher } = await harness();
      const shared = await projectGrantedTo(seed, [admin, launcher]);
      const input = (): MintRequest => ({
        memberId: launcher,
        scope: { kind: "projects", projectIds: [shared] },
        expiresAt: future(30),
      });

      seam.errorFor = leg === "admin" ? admin : launcher;
      const before = await counts(seed.teamId);
      const refused = await mintAgentTokenAction(SLUG, input());
      expect(view(refused)).toEqual({ ok: false, hasToken: false, hasRowId: false });
      expect(refused.error === LOOKUP_ERROR, "refusal names the lookup failure, not a visibility verdict").toBe(true);
      expect(await counts(seed.teamId), "no row, no mint audit").toEqual(before);
      expect(seam.calls.includes(seam.errorFor!), "non-vacuity: the injected leg was actually consulted").toBe(true);

      // Same input, seam reset: the genuine predicate admits it — so the refusal above was the error.
      resetSeam();
      const minted = await mintAgentTokenAction(SLUG, input());
      expect(view(minted)).toEqual({ ok: true, hasToken: true, hasRowId: true });
      expect(await counts(seed.teamId)).toEqual({ tokens: before.tokens + 1, audits: before.audits + 1 });
    });
  }
});

describe("AUDITFIX-19 AC-04 — the action consumes its normalized snapshot, not the caller's object, after the visibility await", () => {
  beforeEach(() => {
    resetSeam();
    vi.mocked(requireTeamAdmin).mockReset();
  });

  it("mutating launcher, name, expiry and scope while the visibility reads are paused changes nothing checked, persisted or audited", async () => {
    const { seed, admin, launcher } = await harness();
    const otherLauncher = await seedMember(seed, "agent");
    const shared = await projectGrantedTo(seed, [admin, launcher]);
    const elsewhere = await projectGrantedTo(seed, [admin, launcher, otherLauncher]);
    const expiresAt = future(25);

    const input = {
      memberId: launcher,
      name: "original label",
      expiresAt,
      scope: { kind: "projects", projectIds: [shared.toUpperCase()] } as { kind: string; projectIds: string[] },
    };

    let release!: () => void;
    seam.gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (seam.onReached = r));

    const pending = mintAgentTokenAction(SLUG, input as unknown as MintRequest);
    await reached;
    // The action is suspended INSIDE its visibility await. Mutate everything the caller owns.
    input.memberId = otherLauncher;
    input.name = "mutated label";
    input.expiresAt = new Date(Date.now() - 60_000).toISOString();
    input.scope.projectIds[0] = elsewhere;
    input.scope.projectIds.push(shared);
    input.scope.kind = "all-reachable";
    (input as Record<string, unknown>).projectScope = [];
    release();
    const res = await pending;

    expect(view(res), "the originally validated request mints").toEqual({ ok: true, hasToken: true, hasRowId: true });
    expect([...new Set(seam.calls)].sort(), "both subset checks used the captured admin and launcher").toEqual([admin, launcher].sort());

    const { data: rowData } = await db()
      .from("agent_tokens")
      .select("member_id, name, expires_at, project_scope")
      .eq("id", res.tokenRowId!)
      .single();
    const row = rowData as { member_id: string; name: string; expires_at: string; project_scope: string[] | null };
    expect(row.member_id).toBe(launcher);
    expect(row.name).toBe("original label");
    expect(Date.parse(row.expires_at)).toBe(Date.parse(expiresAt));
    expect(row.project_scope, "the originally validated canonical [P] reaches storage").toEqual([shared.toLowerCase()]);

    const { data: auditData } = await db()
      .from("audit_log")
      .select("member_id, meta")
      .eq("team_id", seed.teamId)
      .eq("action", "access.token_minted")
      .eq("target_id", res.tokenRowId!);
    const audits = (auditData ?? []) as { member_id: string; meta: Record<string, unknown> }[];
    expect(audits.length).toBe(1);
    expect(audits[0].member_id, "audit actor is the gate's admin").toBe(admin);
    expect([audits[0].meta.member_id, audits[0].meta.on_behalf_of, audits[0].meta.scoped, audits[0].meta.scope_size]).toEqual([
      launcher,
      null,
      true,
      1,
    ]);
  });
});
