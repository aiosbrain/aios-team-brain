import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { completionMessage } from "../../scripts/staging-refresh-decision.mjs";

/**
 * STGENV-3 guards. Spec: docs/design/staging-bounded-projection.md (C12, C13, C25-C27).
 *
 * These are the criteria a behavioural test cannot reach: source-level single-ownership, and the
 * documentation contract that tells an operator how to lift a refusal they will otherwise hit with no
 * way past it.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const sourceFiles = (dir: string) =>
  walk(join(ROOT, dir))
    .map((f) => f.slice(ROOT.length + 1))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

describe("STGENV-3 — single ownership (C12, C13)", () => {
  it("C13: `to_regclass('public.staging_marker')` has exactly ONE owner under lib/", () => {
    // Scoped to `lib/` deliberately. `scripts/staging-refresh.sh` asks the same question in bash and
    // must keep doing so: the refresh script cannot import app code. Two answers INSIDE the app is
    // what this forbids, because they drift and nothing fails loudly when they do.
    const owners = sourceFiles("lib").filter((f) => read(f).includes("to_regclass('public.staging_marker')"));
    expect(owners).toEqual(["lib/env/staging-marker.ts"]);
  });

  it("C12: `projectItemsToGraph(` has exactly ONE non-test call site", () => {
    // The window floor is computed in `run.ts`. A second caller reaching the projector directly would
    // pass no floor and project unbounded — a bypass door that no behavioural test can see, because
    // every test of the projector passes its own floor. `projectSlackToGraph` was exactly that door
    // (zero non-test callers, one internal call) and was deleted in this slice.
    // Strip the DECLARATION before counting, or the defining module always counts as its own caller
    // and the guard can never reach one. A self-call inside `project.ts` would still be caught: only
    // the `export ... function` line is removed, not every mention.
    const callers = [...sourceFiles("lib"), ...sourceFiles("app"), ...sourceFiles("scripts")].filter((f) =>
      /\bprojectItemsToGraph\s*\(/.test(read(f).replace(/export\s+async\s+function\s+projectItemsToGraph\s*\(/g, ""))
    );
    expect(callers).toEqual(["lib/graph/run.ts"]);
  });

  it("C12: the deleted bypass wrapper has not come back", () => {
    const all = [...sourceFiles("lib"), ...sourceFiles("app"), ...sourceFiles("scripts")];
    const offenders = all.filter((f) => /export\s+(async\s+)?function\s+projectSlackToGraph\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe("STGENV-3 — the docs contract (C25, C26, C27)", () => {
  const ops = read("docs/OPS.md");
  const section = ops.slice(ops.indexOf("## 11. Staging refresh"));

  it("C25: OPS §11 documents the window — refusal, no default, cost, and why it is prose", () => {
    // Each clause asserted separately: deleting the "refuse" sentence and deleting the "no default"
    // sentence must redden DIFFERENT assertions, or one of them is riding on the other.
    expect(section).toContain("GRAPH_PROJECT_WINDOW_DAYS");
    expect(section).toMatch(/[Uu]nset on a staging database means REFUSE/);
    expect(section).toMatch(/deliberately NO DEFAULT/i);
    expect(section).toMatch(/\bnot as a row in the variable table\b/i);
    expect(section).toMatch(/pre-STGENV-4 state/i);
    // The cost table an operator needs to pick a number at all.
    expect(section).toMatch(/\|\s*7\s*\|\s*83\s*\|/);
    expect(section).toMatch(/\|\s*30\s*\|\s*727\s*\|/);
  });

  it("C25: OPS §11 never promises a default window", () => {
    // A default would silently decide how much money to spend, which is the one thing this design
    // refuses to do. Asserted as its own negative so it cannot be satisfied by the prose above.
    expect(section).not.toMatch(/defaults? to \d+\s*days?/i);
  });

  it("C26: all FIVE 'no code here can close it' sites moved with the behaviour", () => {
    // Five, not three. Two of them are explanatory docstrings in the same module as the message: an
    // operator who reads only the docstring would otherwise learn the old, wrong contract.
    const decision = read("scripts/staging-refresh-decision.mjs");
    const sites: [string, string][] = [
      ["completionMessage() body", completionMessage()],
      ["staging-refresh-decision.mjs (both docstrings)", decision],
      ["docs/OPS.md §11", section],
      ["this repo's guard for the message", read("test/guards/staging-refresh.test.ts")],
      ["docs/ARCHITECTURE.md", read("docs/ARCHITECTURE.md")],
    ];
    for (const [name, text] of sites) {
      expect(text, `${name}: still says the hazard is unclosable`).not.toMatch(
        /hazard,? (?:that |which )?no code here can close|HAZARD, deliberately left open/i
      );
    }
    // ...and the two that speak to an operator name the way out.
    expect(completionMessage()).toContain("GRAPH_PROJECT_WINDOW_DAYS");
    expect(completionMessage()).toMatch(/REFUSED/);
  });

  it("C27: the architecture map names BOTH the refusal and the window", () => {
    // Two clauses, because either can regress alone — a map that mentions a refusal without saying
    // what lifts it sends the reader to the code to find out, which is what the map exists to avoid.
    const arch = read("docs/ARCHITECTURE.md");
    expect(arch).toMatch(/staging-window-unset/);
    expect(arch).toContain("GRAPH_PROJECT_WINDOW_DAYS");
    expect(arch).toMatch(/window-with-fanout/);
    expect(arch).toMatch(/`work_at`/);
  });
});
