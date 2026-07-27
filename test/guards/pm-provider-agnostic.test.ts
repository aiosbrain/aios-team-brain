import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * BUILD-FAILING GUARD: the timeline/work surfaces must not name a specific PM tool.
 *
 * The brain is self-hosted per organization and each one uses whatever tracker it uses — Linear here,
 * Plane elsewhere, the built-in task UI for a team with neither. A task's provider is therefore DATA
 * (`teams.primary_pm_provider` → `pmSource`, falling back to a generic "tasks" slug), never a literal in
 * the code that renders it. This guard exists because the ask that produced it was explicit: "we should
 * abstract this to use whatever task management software is being used by the user."
 *
 * Scope is deliberately the WORK-TIMELINE surfaces, not the whole repo: `lib/pm-sync/*` and the
 * integrations admin legitimately name providers (they implement them), and `components/icons` maps a
 * provider slug to its brand glyph, which is the correct place for the name to appear.
 */

const WATCHED = [
  "lib/dashboard/work-timeline.ts",
  "lib/dashboard/timeline-group.ts",
  "lib/dashboard/doc-task-infer.ts",
  "lib/dashboard/doc-task-infer-run.ts",
  "lib/dashboard/issue-ref.ts",
  "components/dashboard",
];

/** Provider names that must not steer behaviour on these surfaces. */
const PROVIDER_NAMES = /\b(linear|plane|jira|asana|shortcut)\b/i;

function filesUnder(rel: string): string[] {
  const abs = join(process.cwd(), rel);
  // A renamed/removed target must fail LOUDLY: a guard that silently skips a file it can no longer find
  // reports "clean" for a surface nobody is checking any more.
  if (!existsSync(abs)) throw new Error(`guard target missing: ${rel} — update WATCHED or restore the file`);
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => join(abs, f));
}

/** Comments are allowed to explain the abstraction (and to name the provider that motivated it). */
function codeLines(src: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  let inBlock = false;
  src.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const block = line.indexOf("/*");
    if (block >= 0) {
      inBlock = !line.includes("*/", block);
      line = line.slice(0, block) + (inBlock ? "" : line.slice(line.indexOf("*/", block) + 2));
    }
    const slash = line.indexOf("//");
    if (slash >= 0) line = line.slice(0, slash);
    if (line.trim()) out.push({ line, n: i + 1 });
  });
  return out;
}

describe("guard: the work-timeline surfaces are PM-provider agnostic", () => {
  it("names no specific tracker in executable code", () => {
    const offenders: string[] = [];
    for (const target of WATCHED) {
      for (const file of filesUnder(target)) {
        for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
          if (PROVIDER_NAMES.test(line)) offenders.push(`${file.replace(process.cwd() + "/", "")}:${n}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `A tracker is named in code on a surface that must read it from teams.primary_pm_provider:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is non-vacuous — the matcher does catch a provider name", () => {
    expect(codeLines(`const s = "linear";`).some(({ line }) => PROVIDER_NAMES.test(line))).toBe(true);
    // …and does NOT fire on a comment explaining the abstraction.
    expect(codeLines(`// Linear and Plane both do this\nconst s = pmSource;`).some(({ line }) => PROVIDER_NAMES.test(line))).toBe(false);
  });
});
