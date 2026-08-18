import { describe, expect, it, vi, beforeEach } from "vitest";

// Pins the H2 error-path cursor semantics deterministically (the dm tier can't easily force a
// mid-batch failure). Mocks the internal calls so we control WHICH item fails, then assert the
// returned cursor is the last SUCCESSFUL item — so a resume RETRIES the failed one, never skips it
// (a skipped item = a unit with no membership = invisible content under a Phase-B read).
//
// TICKSTALL-2 moved the SEAM, not the coverage. The sweep now picks its batch with raw SQL
// (`backfill-candidates`), so a `.from()`-only fake can no longer feed it items — this file mocks
// that module instead. The spec required naming this rather than retiring the test to dm, precisely
// because the property below is the one dm cannot easily construct.

const reconcile = vi.fn();
const ensureMembership = vi.fn();
const closeOthers = vi.fn();
const bootstrap = vi.fn();

vi.mock("@/lib/projects/context/units", () => ({ reconcileItemUnit: (...a: unknown[]) => reconcile(...a) }));
vi.mock("@/lib/projects/context/memberships", () => ({
  ensureIncludeMembership: (...a: unknown[]) => ensureMembership(...a),
  closeMembershipInto: (...a: unknown[]) => closeOthers(...a),
}));
const candidates = vi.fn();
vi.mock("@/lib/projects/context/backfill-candidates", () => ({
  selectCandidateItemIds: (...a: unknown[]) => candidates(...a),
  countExcludeShadows: () => Promise.resolve(0),
}));
vi.mock("@/lib/access/bootstrap", () => ({
  ensureAccessBootstrap: (...a: unknown[]) => bootstrap(...a),
  GENERAL_SLUG: "general",
  EXTERNAL_SHARED_SLUG: "external-shared",
}));

// A minimal fake DbClient: only the projects lookup goes through it now — the batch comes from the
// mocked candidate query above.
function fakeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ["select", "eq", "in", "is", "order", "gt", "lt", "limit", "maybeSingle"]) builder[m] = chain;
      if (table === "projects") {
        // resolveSystemProjectIds awaits the builder → { data }
        (builder as { then: unknown }).then = (res: (v: unknown) => void) =>
          res({ data: [{ id: "p-general", slug: "general" }, { id: "p-ext", slug: "external-shared" }], error: null });
      }
      return builder;
    },
  } as unknown as Parameters<typeof import("@/lib/projects/context/backfill").backfillTeamContext>[0];
}

describe("§11 backfill error-path cursor (H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrap.mockResolvedValue({ ok: true });
    closeOthers.mockResolvedValue({ ok: true, closed: 0 });
  });

  it("mid-batch failure returns the PRIOR success as the cursor (retry, not skip)", async () => {
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    candidates.mockResolvedValue({ ids: ["a", "b", "c"] });
    reconcile.mockImplementation((_db, _team, id: string) =>
      Promise.resolve(id === "b" ? { ok: false, error: "boom" } : { ok: true, unitId: `u-${id}`, audience: "team" })
    );
    ensureMembership.mockResolvedValue({ ok: true, created: true });

    const r = await backfillTeamContext(fakeDb(), "team1", { batchSize: 3 });
    expect(r.ok).toBe(false);
    expect(r.cursor, "cursor is the last item that fully succeeded — b will be retried").toBe("a");
  });

  it("first-item failure returns the incoming afterId (retry from before the batch)", async () => {
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    candidates.mockResolvedValue({ ids: ["z"] });
    reconcile.mockResolvedValue({ ok: false, error: "boom" });
    const r = await backfillTeamContext(fakeDb(), "team1", { batchSize: 3, afterId: "prev" });
    expect(r.ok).toBe(false);
    expect(r.cursor, "nothing succeeded → resume from where this batch started").toBe("prev");
  });
});
