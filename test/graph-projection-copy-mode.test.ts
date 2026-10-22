import { describe, expect, it, vi } from "vitest";
import { runGraphProjection } from "@/lib/graph/run";
import type { StagingRuntimeState } from "@/lib/staging/runtime-policy";

/**
 * M3 — a COPIED staging runtime refuses graph projection BEFORE it touches the corpus.
 *
 * The defect this pins is not provider spend: the Graphiti gate already stopped extraction, so
 * nothing was billed and nothing leaked. It is that `project.ts` MOVES ledger identity and RESERVES
 * ledger entries before `client.addEpisodes`, so every tick on a copied instance ran a full corpus
 * scan and rewrote ledger rows that belong to the COPY of production's data. The observable claim is
 * therefore a NEGATIVE one — no corpus query, no lease, no episode push — and only a seam can
 * express it, because "the runner returned a refusal" is equally true of a run that scanned first.
 *
 * `copy-safe-refusal` is included as its own row rather than folded into `copy-ready`: it means the
 * staging posture could not be ESTABLISHED, and an unestablished posture is not permission. The two
 * production rows below are the positive controls — without them a guard that simply broke
 * projection everywhere would look identical to a correct one.
 */

/** A `DbClient` that RECORDS every table it is asked for. Reaching it at all is the failure. */
function recordingDb(rows: { id: string; slug: string }[] = []) {
  const tables: string[] = [];
  const builder = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.gt = () => b;
    b.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error: null });
    return b;
  };
  return {
    tables,
    db: {
      from: (table: string) => { tables.push(table); return builder(); },
      rpc: async (fn: string) => { tables.push(`rpc:${fn}`); return { data: null, error: null }; },
    },
  };
}

const configuredClient = (addEpisodes: ReturnType<typeof vi.fn>) => ({
  configured: true,
  addEpisodes,
});

const runtime = (mode: StagingRuntimeState["mode"]): StagingRuntimeState => ({
  mode,
  ready: mode === "production" || mode === "legacy-pg-only",
  runId: null,
});

describe("M3 — graph projection on a copied staging runtime", () => {
  for (const mode of ["copy-ready", "copy-safe-refusal"] as const) {
    it(`refuses a ${mode} runtime with no corpus read, no lease and no episode push`, async () => {
      const { tables, db } = recordingDb([{ id: "team-1", slug: "acme" }]);
      const addEpisodes = vi.fn();
      const lease = vi.fn();
      const fanoutSurface = vi.fn();
      const stagingMarker = vi.fn(async () => true);

      const summary = await runGraphProjection({
        teamId: "team-1",
        db: db as never,
        client: configuredClient(addEpisodes) as never,
        lease,
        fanoutSurface,
        stagingMarker,
        stagingRuntimeState: async () => runtime(mode),
        // A WINDOW IS SET AND VALID, so the window precondition would have proceeded. Without this
        // the run could refuse for the window's reason and this test would certify nothing about
        // the runtime gate.
        windowDays: "30",
        now: new Date("2026-09-08T00:00:00Z"),
      });

      expect(summary.ok).toBe(false);
      expect(summary.refused).toBe("copied-staging-runtime");
      expect(summary.errors.join(" ")).toContain(mode);

      // The whole point: it refused BEFORE anything read or wrote.
      expect(tables, "a copied runtime issued a corpus query").toEqual([]);
      expect(lease, "a copied runtime took a projection lease").not.toHaveBeenCalled();
      expect(addEpisodes, "a copied runtime pushed episodes").not.toHaveBeenCalled();
      expect(fanoutSurface, "a copied runtime probed the fan-out surface").not.toHaveBeenCalled();
      // …and before the window/marker precondition, which is what "before ANY read" means here.
      expect(stagingMarker, "the runtime gate ran after the marker read").not.toHaveBeenCalled();
      expect(summary.scanned).toBe(0);
      expect(summary.teams).toBe(0);
    });
  }

  it("POSITIVE CONTROL: a production runtime still reaches the corpus", async () => {
    // Without this row, deleting `resolveTeams` entirely would leave the assertions above green.
    const { tables, db } = recordingDb([]);
    const addEpisodes = vi.fn();

    const summary = await runGraphProjection({
      teamId: "team-1",
      db: db as never,
      client: configuredClient(addEpisodes) as never,
      stagingMarker: async () => false,
      stagingRuntimeState: async () => runtime("production"),
      // `""` is UNSET, explicitly — passing `undefined` would fall through to the ambient
      // GRAPH_PROJECT_WINDOW_DAYS and make this row depend on the shell it ran in.
      windowDays: "",
      now: new Date("2026-09-08T00:00:00Z"),
    });

    expect(summary.refused).toBeUndefined();
    expect(summary.ok).toBe(true);
    expect(tables, "production never reached the corpus, so the negative rows prove nothing").toContain("teams");
  });

  it("POSITIVE CONTROL: legacy-pg-only staging keeps its bounded-window behaviour", async () => {
    // `legacy-pg-only` is a supported staging mode and is NOT a copied runtime. The M3 gate must not
    // have swallowed the STGENV-3 window semantics that mode depends on.
    const { tables, db } = recordingDb([]);

    const summary = await runGraphProjection({
      teamId: "team-1",
      db: db as never,
      client: configuredClient(vi.fn()) as never,
      stagingMarker: async () => true,
      stagingRuntimeState: async () => runtime("legacy-pg-only"),
      windowDays: "30",
      now: new Date("2026-09-08T00:00:00Z"),
    });

    expect(summary.refused).toBeUndefined();
    expect(tables).toContain("teams");
  });

  it("POSITIVE CONTROL: an unconfigured client is still a clean no-op, not a runtime refusal", async () => {
    // The `configured` gate sits BEFORE the runtime gate on purpose: with no GRAPHITI_URL the runner
    // must not open the database at all. A refusal reason here would mean the M3 gate had been
    // placed above it and made an unconfigured production instance look like copied staging.
    const { tables, db } = recordingDb([]);
    const stagingRuntimeState = vi.fn(async () => runtime("copy-ready"));

    const summary = await runGraphProjection({
      teamId: "team-1",
      db: db as never,
      client: { configured: false, addEpisodes: vi.fn() } as never,
      stagingRuntimeState,
    });

    expect(summary.configured).toBe(false);
    expect(summary.ok).toBe(true);
    expect(summary.refused).toBeUndefined();
    expect(stagingRuntimeState).not.toHaveBeenCalled();
    expect(tables).toEqual([]);
  });
});
