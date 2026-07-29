// Spec: after pasting a connector token, the operator must be able to tell — from the terminal,
// immediately — whether it is configured, whether it ran, and whether anything arrived. These
// assertions come from that intent and from README §1.4/§2.6, not from the implementation.
//
// The distinction that matters most: "ran and found nothing new" is a SUCCESS. Reporting it as a
// failure would send people hunting for a broken token that works fine.
import { describe, expect, it } from "vitest";
import {
  type IntegrationRow,
  type RunRow,
  firstError,
  formatConnectorTable,
  hasActionableProblem,
  latestBySource,
  summarizeConnector,
  summarizeConnectors,
} from "../lib/ingest/connector-status";

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const enabled = (type: string, has_secret = true): IntegrationRow => ({
  type,
  name: type,
  status: "enabled",
  has_secret,
});

const run = (source: string, over: Partial<RunRow> = {}): RunRow => ({
  source,
  ok: true,
  created: 0,
  updated: 0,
  unchanged: 0,
  error_count: 0,
  errors: [],
  finished_at: ago(5 * MIN),
  ...over,
});

describe("a connector that ran and found nothing is HEALTHY", () => {
  it("does not report an empty successful run as a problem", () => {
    const s = summarizeConnector("slack", enabled("slack"), run("slack"), NOW);
    expect(s.verdict).toBe("ok");
    expect(s.detail).toMatch(/nothing new/i);
    expect(s.detail).toMatch(/not a failure/i);
  });

  it("reports what actually landed when something did", () => {
    const s = summarizeConnector("slack", enabled("slack"), run("slack", { created: 14, updated: 2 }), NOW);
    expect(s.verdict).toBe("ok");
    expect(s.detail).toMatch(/14 created/);
    expect(s.detail).toMatch(/2 updated/);
  });

  // Regression: relativeAge already returns "4m ago"/"just now", so appending " ago" produced
  // "4m ago ago" — and "just now ago" for a fresh run. Caught running against a real database.
  it("never doubles the age suffix, including the 'just now' case", () => {
    for (const finished_at of [ago(4 * MIN), ago(1000)]) {
      for (const counts of [{ created: 7, updated: 1 }, { created: 0, updated: 0 }]) {
        const d = summarizeConnector("slack", enabled("slack"), run("slack", { ...counts, finished_at }), NOW).detail;
        expect(d).not.toMatch(/ago ago/);
        expect(d).not.toMatch(/just now ago/);
      }
    }
  });
});

describe("failures name the cause instead of a status code", () => {
  it("surfaces the recorded error message verbatim", () => {
    const s = summarizeConnector(
      "slack",
      enabled("slack"),
      run("slack", { ok: false, error_count: 1, errors: ["missing_scope: channels:read"] }),
      NOW
    );
    expect(s.verdict).toBe("fail");
    expect(s.detail).toBe("missing_scope: channels:read");
  });

  it("still fails loudly when a failed run recorded no message", () => {
    const s = summarizeConnector("linear", enabled("linear"), run("linear", { ok: false }), NOW);
    expect(s.verdict).toBe("fail");
    expect(s.detail).toMatch(/no recorded message/i);
  });
});

describe("credentials — GitHub is deliberately the exception", () => {
  it("fails a credential-bearing connector with no stored secret", () => {
    const s = summarizeConnector("slack", enabled("slack", false), undefined, NOW);
    expect(s.verdict).toBe("fail");
    // The real-world cause is an unset SECRETS_KEY making the save 500 — say so.
    expect(s.detail).toMatch(/SECRETS_KEY/);
  });

  it("does NOT fail GitHub without a token — public repos ingest token-free (README §1.4)", () => {
    const s = summarizeConnector("github", enabled("github", false), run("github", { created: 3 }), NOW);
    expect(s.verdict).toBe("ok");
  });
});

describe("states that are neither success nor failure", () => {
  it("marks a configured connector that has never run as pending, not broken", () => {
    const s = summarizeConnector("plane", enabled("plane"), undefined, NOW);
    expect(s.verdict).toBe("pending");
    expect(s.detail).toMatch(/30 min|verify/i); // tells them how to stop waiting
  });

  it("marks a disabled connector as a warning, not a failure", () => {
    const s = summarizeConnector("slack", { ...enabled("slack"), status: "disabled" }, undefined, NOW);
    expect(s.verdict).toBe("warn");
    expect(s.detail).toMatch(/disabled/i);
  });

  it("marks an unconfigured connector absent and points at where to add it", () => {
    const s = summarizeConnector("linear", undefined, undefined, NOW);
    expect(s.verdict).toBe("absent");
    expect(s.detail).toMatch(/Admin → Integrations/);
  });
});

describe("summarizeConnectors", () => {
  it("always reports all four connectors, including ones never set up", () => {
    expect(summarizeConnectors([], [], NOW).map((s) => s.type)).toEqual(["slack", "github", "linear", "plane"]);
  });

  it("uses the newest run per source", () => {
    const statuses = summarizeConnectors(
      [enabled("slack")],
      [
        run("slack", { created: 1, finished_at: ago(90 * MIN) }),
        run("slack", { created: 99, finished_at: ago(2 * MIN) }),
      ],
      NOW
    );
    expect(statuses.find((s) => s.type === "slack")!.created).toBe(99);
  });

  it("prefers the enabled row when a team has several of one type", () => {
    const s = summarizeConnectors(
      [{ ...enabled("slack"), status: "disabled", name: "old" }, { ...enabled("slack"), name: "current" }],
      [],
      NOW
    );
    expect(s.find((x) => x.type === "slack")!.verdict).toBe("pending"); // the enabled one won
  });

  it("ignores runs from non-connector legs like dense or graph_project", () => {
    const s = summarizeConnectors([enabled("slack")], [run("dense", { created: 500 })], NOW);
    expect(s.find((x) => x.type === "slack")!.created).toBe(0);
  });
});

describe("exit-code signal", () => {
  it("is actionable only on a real failure — pending and absent must not block setup", () => {
    expect(hasActionableProblem(summarizeConnectors([], [], NOW))).toBe(false);
    expect(hasActionableProblem(summarizeConnectors([enabled("slack")], [], NOW))).toBe(false);
    expect(
      hasActionableProblem(summarizeConnectors([enabled("slack")], [run("slack", { ok: false })], NOW))
    ).toBe(true);
  });
});

describe("firstError", () => {
  it("reads an array, a JSON-encoded array, and tolerates junk", () => {
    expect(firstError(["boom"])).toBe("boom");
    expect(firstError('["boom"]')).toBe("boom");
    expect(firstError([])).toBeNull();
    expect(firstError(null)).toBeNull();
    expect(firstError("not json")).toBeNull();
    expect(firstError([{ nested: true }])).toBeNull();
  });
});

describe("latestBySource", () => {
  it("returns the newest row per source regardless of input order", () => {
    const m = latestBySource([
      run("slack", { created: 1, finished_at: ago(1 * MIN) }),
      run("slack", { created: 2, finished_at: ago(60 * MIN) }),
      run("github", { created: 3, finished_at: ago(30 * MIN) }),
    ]);
    expect(m.get("slack")!.created).toBe(1);
    expect(m.get("github")!.created).toBe(3);
  });
});

describe("formatConnectorTable", () => {
  it("renders one actionable line per connector", () => {
    const out = formatConnectorTable(summarizeConnectors([enabled("slack")], [run("slack", { created: 4 })], NOW));
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toMatch(/✓ slack/);
    expect(out).toMatch(/· linear/); // absent marker
  });
});
