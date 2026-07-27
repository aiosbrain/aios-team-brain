import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECTION_INTERVAL_MS, PROJECTION_MINUTES } from "@/lib/graph/project";
import { GRACE_MS, LANDED_GRACE_MS } from "@/lib/graph/reconcile";

/**
 * Single-source guard for the projector's cadence (CLAUDE.md §2, Pass-1 review H7).
 *
 * H7's fix rests on one claim: reconcile won't judge an episode "never landed" until at least a full
 * projection cycle has passed, because until the projector's NEXT run the row can't be re-pushed
 * anyway. That argument is only sound while reconcile's grace and the scheduler's timer are the SAME
 * number. Two independent `process.env.GRAPH_PROJECT_MINUTES` reads would satisfy it on the default
 * and diverge on a configured value — `Number()` and `resolvePositiveInt` disagree on `"0.5"`, `""`,
 * and `"abc"` — reopening the re-push loop only on the deployments that tuned the knob.
 *
 * That's the H6 shape exactly (`PM_SOURCES` as a Set in the predicate AND a literal in the SQL):
 * nothing fails, the copies just drift. So the guard is on a second READING appearing, not on
 * behaviour — no behavioural test on one consumer can see the other one disagreeing.
 *
 * KNOWN BLIND SPOT: an indirect read via a computed key (`const k = "GRAPH_PROJECT_MINUTES";
 * process.env[k]`) doesn't match, because the literal and the lookup are on different lines. Nothing in
 * this codebase reads env that way; a reviewer should still look by hand. Destructuring
 * (`const { GRAPH_PROJECT_MINUTES } = process.env`) IS matched — it was a hole in the first version.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "graph", "project.ts");
/**
 * The three shapes a second read can take: dotted access, bracketed string key, and a destructure off
 * `process.env`. The destructure alternative is why this isn't just `/process\.env\.NAME/` —
 * `instrumentation.ts` registers the scheduler and is exactly where a stray one would appear.
 */
const ENV_READ_RE = new RegExp(
  [
    String.raw`process\.env\.GRAPH_PROJECT_MINUTES`,
    String.raw`process\.env\[\s*["'\`]GRAPH_PROJECT_MINUTES`,
    String.raw`\{[^{}]*\bGRAPH_PROJECT_MINUTES\b[^{}]*\}\s*=\s*process\.env`,
  ].join("|"),
  "g"
);

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
    else if (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/** Root-level source files — `instrumentation.ts` (which registers the scheduler), `next.config.ts`, … */
function rootFiles(): string[] {
  return readdirSync(ROOT)
    .map((n) => join(ROOT, n))
    .filter((p) => !statSync(p).isDirectory() && (p.endsWith(".ts") || p.endsWith(".mjs")));
}

function scanned(): string[] {
  return [...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))), ...rootFiles()];
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const file of scanned()) {
    const rel = file.slice(ROOT.length + 1);
    if (rel === OWNER || rel.endsWith(".test.ts")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(ENV_READ_RE)) hits.push(`${rel}: ${m[0]}`);
  }
  return [...new Set(hits)].sort();
}

describe("guard: one projection cadence", () => {
  it("only lib/graph/project reads GRAPH_PROJECT_MINUTES", () => {
    expect(
      offenders(),
      `A second read of GRAPH_PROJECT_MINUTES is a second definition of the projector's cadence. ` +
        `reconcile's H7 grace is derived from it, so a divergent parse reopens the re-push loop on any ` +
        `deployment that sets the knob. Import PROJECTION_MINUTES / PROJECTION_INTERVAL_MS instead:\n` +
        offenders().join("\n")
    ).toEqual([]);
  });

  it("is non-vacuous: the pattern it looks for is detectable", () => {
    // Pins the regex. A broken pattern would leave this guard green forever while the drift it exists
    // to catch walked back in — the silent-failure shape it is guarding against.
    for (const drift of [
      `const minutes = Number(process.env.GRAPH_PROJECT_MINUTES ?? 60);`, // the exact line removed
      `resolvePositiveInt(process.env.GRAPH_PROJECT_MINUTES, 60)`,
      `process.env["GRAPH_PROJECT_MINUTES"]`,
      `const { GRAPH_PROJECT_MINUTES } = process.env;`, // destructure — a hole in the first version
      `const { GRAPH_PROJECT_MINUTES = "60", OTHER } = process.env;`,
    ]) {
      expect([...drift.matchAll(ENV_READ_RE)], drift).toHaveLength(1);
    }
    // Consuming the owner's export is the encouraged pattern, not drift.
    expect([...`const ms = PROJECTION_INTERVAL_MS;`.matchAll(ENV_READ_RE)]).toHaveLength(0);
    // And the scan actually reaches the files a drift would live in, so `offenders()` isn't green
    // because it walked an empty tree. `instrumentation.ts` registers the scheduler and sits at the
    // repo root — outside SCAN_DIRS, which is why root files are scanned explicitly.
    const files = scanned();
    expect(files).toContain(join(ROOT, "lib", "graph", "scheduler.ts"));
    expect(files).toContain(join(ROOT, "instrumentation.ts"));
  });

  it("keeps reconcile's grace at or above one full projection cycle (H7's premise)", () => {
    expect(PROJECTION_INTERVAL_MS).toBe(PROJECTION_MINUTES * 60_000);
    // The whole no-feedback-loop argument: a row is never judged before the projector could have
    // re-pushed it. Also never shorter than the extraction floor.
    expect(LANDED_GRACE_MS).toBeGreaterThanOrEqual(PROJECTION_INTERVAL_MS);
    expect(LANDED_GRACE_MS).toBeGreaterThanOrEqual(GRACE_MS);
  });
});
