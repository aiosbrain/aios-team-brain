import { describe, expect, it } from "vitest";
import {
  parseConfirmFlags,
  runMaterializeCommand,
  type FleetState,
  type MaterializeResult,
} from "@/lib/access/materialize-command";

/**
 * STAGINGMARK-1 acceptance, AC1–AC8. Spec: docs/design/stagingmark1-materialize-oneshot.md.
 *
 * These are BEHAVIOURAL, against injected fakes, because the thing worth pinning is which branch
 * runs and what it exits with — not that a source file mentions a function name. The design review
 * killed an earlier source-text-only criterion by pointing out that
 * `case "materialize-builtins": { /* materializeBuiltinMembershipOnce *\/ break; }` would satisfy it
 * while doing nothing.
 */

/**
 * A counting fake. "Was it called?" is asserted with `calls`, NEVER by having the fake throw:
 * the diff review caught that a throwing fake proves nothing here, because the handler CATCHES a
 * thrown materializer by design (AC6c) and turns it into exit 1 — so a "must not be called" fake
 * that throws is silently absorbed and its test can still pass for the wrong reason.
 */
function spy(result: MaterializeResult) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls++;
      return result;
    },
  };
}

const state = (over: Partial<FleetState> = {}): FleetState => ({
  marker: false,
  teams: 1,
  stagingMarker: true,
  contentWithoutSubstrate: false,
  ...over,
});

const staging = (over: Partial<FleetState> = {}) => async () => state(over);

describe("STAGINGMARK-1 — materialize-builtins handler", () => {
  it("AC1 — an already-materialized fleet never calls the materializer", async () => {
    const m = spy({ ok: true, ran: true });
    const out = await runMaterializeCommand(
      { readState: staging({ marker: true }), materialize: m.fn },
      { confirm: true, confirmProduction: true }
    );
    expect(m.calls, "the marker-present path must perform zero writes").toBe(0);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/already materialized/i);
  });

  it("AC2 — without --confirm a markerless fleet is not written", async () => {
    const m = spy({ ok: true, ran: true });
    const out = await runMaterializeCommand(
      { readState: staging({ marker: false, teams: 3 }), materialize: m.fn },
      { confirm: false, confirmProduction: false }
    );
    expect(m.calls).toBe(0);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("3 team(s)");
    expect(out.lines.join("\n")).toMatch(/DRY RUN/);
  });

  it("AC3 — with --confirm it runs", async () => {
    const m = spy({ ok: true, ran: true });
    const out = await runMaterializeCommand(
      { readState: staging({ marker: false, teams: 2 }), materialize: m.fn },
      { confirm: true, confirmProduction: false }
    );
    expect(m.calls).toBe(1);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/materialization ran/i);
  });

  it("AC4 — a failure exits non-zero and surfaces the error", async () => {
    const out = await runMaterializeCommand(
      { readState: staging(), materialize: async () => ({ ok: false, error: "boom" }) },
      { confirm: true, confirmProduction: false }
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.lines.join("\n")).toContain("boom");
    expect(out.lines.join("\n")).toMatch(/this run did not stamp the marker/i);
  });

  it("AC5 — the three outcomes are pairwise distinguishable, and only the failure reads as failure", async () => {
    const done = await runMaterializeCommand(
      { readState: staging({ marker: true }), materialize: spy({ ok: true, ran: true }).fn },
      { confirm: true, confirmProduction: true }
    );
    const ran = await runMaterializeCommand(
      { readState: staging(), materialize: async () => ({ ok: true, ran: true }) },
      { confirm: true, confirmProduction: true }
    );
    const failed = await runMaterializeCommand(
      { readState: staging(), materialize: async () => ({ ok: false, error: "boom" }) },
      { confirm: true, confirmProduction: true }
    );
    const texts = [done, ran, failed].map((o) => o.lines.join("\n"));
    expect(new Set(texts).size).toBe(3);
    expect(texts.filter((t) => /fail/i.test(t))).toHaveLength(1);
    expect(texts[2]).toMatch(/fail/i);
  });

  describe("AC6 — the remaining non-success states exit non-zero", () => {
    it("(a) a failing readState never reaches the materializer", async () => {
      const m = spy({ ok: true, ran: true });
      const out = await runMaterializeCommand(
        {
          readState: async () => {
            throw new Error("connection refused");
          },
          materialize: m.fn,
        },
        { confirm: true, confirmProduction: true }
      );
      expect(m.calls, "a failed state read must not reach the materializer").toBe(0);
      expect(out.exitCode).not.toBe(0);
      expect(out.lines.join("\n")).toContain("connection refused");
    });

    it("(b) a database with no staging_marker refuses without --confirm-production", async () => {
      const m = spy({ ok: true, ran: true });
      const out = await runMaterializeCommand(
        { readState: staging({ stagingMarker: false }), materialize: m.fn },
        { confirm: true, confirmProduction: false }
      );
      expect(m.calls).toBe(0);
      expect(out.exitCode).not.toBe(0);
      expect(out.lines.join("\n")).toContain("--confirm-production");
      expect(out.lines.join("\n")).toMatch(/may be PRODUCTION/);
    });

    it("(b') …and proceeds once --confirm-production is given", async () => {
      const m = spy({ ok: true, ran: true });
      const out = await runMaterializeCommand(
        { readState: staging({ stagingMarker: false }), materialize: m.fn },
        { confirm: true, confirmProduction: true }
      );
      expect(m.calls).toBe(1);
      expect(out.exitCode).toBe(0);
    });

    it("(c) a materializer that THROWS is caught and exits non-zero", async () => {
      const out = await runMaterializeCommand(
        {
          readState: staging(),
          materialize: async () => {
            throw new Error("pool exhausted");
          },
        },
        { confirm: true, confirmProduction: true }
      );
      expect(out.exitCode).not.toBe(0);
      expect(out.lines.join("\n")).toContain("pool exhausted");
      expect(out.lines.join("\n")).toMatch(/this run did not stamp the marker/i);
      // …and it must NOT assert the marker is absent, which this run never re-read.
      expect(out.lines.join("\n")).not.toMatch(/marker is NOT stamped/i);
    });
  });

  describe("AC7 — success states that did not reconcile are not reported as a run", () => {
    it("the boot/tick race (ran:false) reports 'already completed', not a run", async () => {
      const out = await runMaterializeCommand(
        { readState: staging(), materialize: async () => ({ ok: true, ran: false }) },
        { confirm: true, confirmProduction: true }
      );
      expect(out.exitCode).toBe(0);
      expect(out.lines.join("\n")).toMatch(/already completed concurrently/i);
      expect(out.lines.join("\n")).not.toMatch(/materialization ran/i);
    });

    it("a zero-team fleet says the marker was stamped and nothing reconciled", async () => {
      const out = await runMaterializeCommand(
        { readState: staging({ teams: 0 }), materialize: async () => ({ ok: true, ran: true }) },
        { confirm: true, confirmProduction: true }
      );
      expect(out.exitCode).toBe(0);
      expect(out.lines.join("\n")).toMatch(/zero teams reconciled/i);
    });
  });

  describe("STAGINGMARK-2 — the CLI refuses the shape the migration refuses", () => {
    // The diff review found this hole: the SQL gate sits AFTER the marker short-circuit, so a stamp
    // from this command clears the migration's refusal and the next deploy proceeds over a dark
    // corpus. A doc sentence would not have closed it.
    it("refuses content-without-substrate, and does NOT reach the materializer", async () => {
      const m = spy({ ok: true, ran: true });
      const out = await runMaterializeCommand(
        { readState: staging({ contentWithoutSubstrate: true }), materialize: m.fn },
        { confirm: true, confirmProduction: true }
      );
      expect(m.calls, "a stamp here would silently clear the PRET-6 gate").toBe(0);
      expect(out.exitCode).not.toBe(0);
      expect(out.lines.join("\n")).toMatch(/no context substrate/i);
    });

    it("refuses it BEFORE --confirm is considered — it is not a confirmation question", async () => {
      const m = spy({ ok: true, ran: true });
      const out = await runMaterializeCommand(
        { readState: staging({ contentWithoutSubstrate: true }), materialize: m.fn },
        { confirm: false, confirmProduction: false }
      );
      expect(m.calls).toBe(0);
      expect(out.exitCode, "a dry run must not report this as merely unconfirmed").not.toBe(0);
      expect(out.lines.join("\n")).toMatch(/no context substrate/i);
    });

    it("the INVERSE: a partitioned fleet is unaffected and still materializes", async () => {
      const m = spy({ ok: true, ran: true });
      const out = await runMaterializeCommand(
        { readState: staging({ contentWithoutSubstrate: false }), materialize: m.fn },
        { confirm: true, confirmProduction: true }
      );
      expect(m.calls).toBe(1);
      expect(out.exitCode).toBe(0);
    });
  });

  describe("AC8 — --confirm is a bare flag and a value is refused", () => {
    it("accepts the bare forms", () => {
      expect(parseConfirmFlags({})).toEqual({ ok: true, confirm: false, confirmProduction: false });
      expect(parseConfirmFlags({ confirm: true })).toEqual({ ok: true, confirm: true, confirmProduction: false });
      expect(parseConfirmFlags({ confirm: true, "confirm-production": true })).toEqual({
        ok: true,
        confirm: true,
        confirmProduction: true,
      });
    });

    it("refuses `--confirm false` — the trap that reads as CONFIRMED today", () => {
      // The original tokenizer made `--confirm false` truthy as confirmation. The shared argv
      // boundary now prevents that on purge-items; this defense still rejects malformed maps.
      const parsed = parseConfirmFlags({ confirm: "false" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/takes no value/);
    });

    it("refuses `--confirm-production <value>` too", () => {
      const parsed = parseConfirmFlags({ confirm: true, "confirm-production": "yes" });
      expect(parsed.ok).toBe(false);
    });

    it("refuses the `=` form rather than silently ignoring it", () => {
      // parseArgs makes the whole token the KEY, so this would otherwise go unseen and dry-run.
      const parsed = parseConfirmFlags({ "confirm=false": true });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/bare/);
    });
  });
});
