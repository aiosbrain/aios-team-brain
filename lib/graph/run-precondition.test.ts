import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GraphitiClient } from "@/lib/graph/graphiti-client";
import { runGraphProjection } from "@/lib/graph/run";
import { shouldRecordProjectionRun, projectionRunInput } from "@/lib/graph/projection-run";

// Spec: docs/design/staging-bounded-projection.md — C9, C10, C14-C17.
// The wiring criteria. These exist because the pure decision and the projector can BOTH be correct
// while nothing connects them, which is the defect class this repo keeps recording.

const configured = () => new GraphitiClient({ baseUrl: "http://graphiti.test" });
const ROOT = join(import.meta.dirname, "..", "..");

describe("runGraphProjection — the precondition's wiring (C9, C10)", () => {
  it("C9: a global refusal never touches the database", async () => {
    // Before `resolveTeams`, so refusing costs no query at all. SCOPED to the three global reasons:
    // D3e's fan-out refusal necessarily follows team resolution and MUST query, so an unscoped
    // version of this and the fan-out criterion could not both hold.
    const from = vi.fn(() => {
      throw new Error("DB must not be touched when the precondition refuses");
    });
    const res = await runGraphProjection({
      client: configured(),
      db: { from } as never,
      stagingMarker: async () => true,
      windowDays: undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.refused).toBe("staging-window-unset");
    expect(from).not.toHaveBeenCalled();
  });

  it("C9: an invalid window and an unreadable marker refuse the same way", async () => {
    const from = vi.fn(() => {
      throw new Error("DB must not be touched when the precondition refuses");
    });
    const invalid = await runGraphProjection({
      client: configured(),
      db: { from } as never,
      stagingMarker: async () => false,
      windowDays: "0",
    });
    expect(invalid.refused).toBe("invalid-window");

    const unknown = await runGraphProjection({
      client: configured(),
      db: { from } as never,
      stagingMarker: async () => {
        throw new Error("pool exhausted");
      },
      windowDays: "30",
    });
    expect(unknown.refused).toBe("staging-state-unknown");
    expect(unknown.errors.join(" ")).toContain("pool exhausted");
    expect(from).not.toHaveBeenCalled();
  });

  it("C10: with Graphiti unconfigured the marker seam records ZERO calls", async () => {
    // The precondition sits AFTER the configured gate. Naming the observable matters: "no marker
    // read" is otherwise unfalsifiable, and moving the precondition above the gate would break the
    // long-standing "never touches the DB when unconfigured" contract in a way nothing else sees.
    const stagingMarker = vi.fn(async () => true);
    const from = vi.fn(() => {
      throw new Error("DB must not be touched when Graphiti is unconfigured");
    });
    const res = await runGraphProjection({
      client: new GraphitiClient({ baseUrl: "" }),
      db: { from } as never,
      stagingMarker,
      windowDays: undefined,
    });
    expect(res.configured).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.refused).toBeUndefined();
    expect(stagingMarker).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("C9: a refusal reports configured:true, so the admin path reads it as a refusal not a no-op", async () => {
    // `projectToGraphNow` checks `!s.configured` FIRST and returns "graph memory is not configured".
    // A refusal that reported `configured:false` would be shown to the admin as the wrong problem.
    const res = await runGraphProjection({
      client: configured(),
      db: { from: () => { throw new Error("unused"); } } as never,
      stagingMarker: async () => true,
      windowDays: undefined,
    });
    expect(res.configured).toBe(true);
  });
});

describe("the refusal is SEEN (C14-C17)", () => {
  const refusal = async () =>
    runGraphProjection({
      client: configured(),
      db: { from: () => { throw new Error("unused"); } } as never,
      stagingMarker: async () => true,
      windowDays: undefined,
    });

  it("C14: the scheduler records a row for it — every tick, until the window is set", async () => {
    const s = await refusal();
    expect(shouldRecordProjectionRun(s)).toBe(true);
  });

  it("C15: the durable row is RED and carries `refused` in its meta", async () => {
    // `projectionRunInput` ENUMERATES its meta keys, so a field added to the summary and not added
    // there exists only in memory. That is the failure this pins.
    const s = await refusal();
    const input = projectionRunInput(s, "manual", Date.now() - 10, Date.now());
    expect(input.ok).toBe(false);
    expect((input.meta as Record<string, unknown>).refused).toBe("staging-window-unset");
    expect(input.errors.join(" ")).toContain("GRAPH_PROJECT_WINDOW_DAYS");
  });

  it("C16: the admin action's own condition surfaces this exact shape", async () => {
    const s = await refusal();
    // The predicate `projectToGraphNow` actually uses, asserted against the real summary...
    expect(!s.ok && s.errors.length > 0).toBe(true);
    // ...and pinned at the call site, so the condition cannot drift away from the shape above.
    const actions = readFileSync(
      join(ROOT, "app", "t", "[team]", "admin", "integrations", "actions.ts"),
      "utf8"
    );
    expect(actions).toMatch(/if \(!s\.ok && s\.errors\.length\) return \{ ok: false, error: s\.errors\.join\("; "\) \};/);
    // The reason a human reads must name both the state and the way out of it.
    const shown = s.errors.join("; ");
    expect(shown).toContain("staging_marker");
    expect(shown).toContain("GRAPH_PROJECT_WINDOW_DAYS");
  });

  it("C17: the battery script prints the REASON, not merely a non-zero exit", async () => {
    // The exit code alone could never fail: `process.exit(!s.episodes || s.errors.length ? 1 : 0)`
    // already exits 1 on any zero-episode run. What has to be pinned is the reason reaching a human.
    const script = readFileSync(join(ROOT, "scripts", "graph-window-battery", "run-projection.ts"), "utf8");
    expect(script).toMatch(/s\.errors\.length \? `\\n\[battery\] ERRORS: \$\{s\.errors\.join\("; "\)\}` : ""/);
    const s = await refusal();
    expect(s.errors.length).toBeGreaterThan(0);
  });
});
