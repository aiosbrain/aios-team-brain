import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_STATUSES, OPEN_STATUSES } from "@/lib/tasks/activity-policy";

/**
 * Single-source guard for "is this task active" (CLAUDE.md §2, Pass-1 review H6).
 *
 * The question was answered independently in five places and three different ways — the work timeline
 * said `{in_progress, blocked}`, the Home box and the Pulse metric each kept their own
 * `{ready, in_progress, blocked}` Set, and arc eligibility answered it from Linear's raw state
 * vocabulary (so Plane was never gated at all). Nothing failed; the surfaces just disagreed, and adding
 * a provider silently opted out of the rule.
 *
 * So the failure mode this guards is DRIFT, and drift can't be caught by testing behaviour on one
 * surface — you have to notice a second definition appearing. This looks for one being written down.
 *
 * KNOWN BLIND SPOTS (a regex over source can't be complete, so they're named rather than implied):
 *   • `components/` is not scanned. It holds the status VOCABULARY for the kanban board, which would
 *     need its own exemption; a client-side activity subset would slip past. None exists today.
 *   • Raw-SQL filters (`status in ('in_progress','blocked')` inside a `runSql` template) don't match the
 *     bracketed-list shape. This codebase does write raw SQL elsewhere.
 * Both are places a reviewer should still look by hand.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib"];
const OWNER = join("lib", "tasks", "activity-policy.ts");

/**
 * A `Set` (or array) literal that spells out task statuses. Matches the shape the drifted copies all
 * had — `new Set(["ready", "in_progress", …])` — by looking for two or more status literals inside one
 * bracketed list. Two is the threshold because a single `=== "done"` comparison is a legitimate,
 * readable check; a LIST of statuses is a policy, and policies belong in one place.
 */
const STATUS = "(?:backlog|ready|in_progress|blocked|done)";
const QUOTED = `(?:"${STATUS}"|'${STATUS}'|\`${STATUS}\`)`;
// `\s` spans newlines, so a set written one status per line is caught too. Backticks are included
// because a template literal is just as much a second definition and no other guard would see it.
const STATUS_LIST_RE = new RegExp(`\\[\\s*${QUOTED}\\s*,\\s*${QUOTED}`, "g");

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

function offenders(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === OWNER || rel.endsWith(".test.ts")) continue;
      // The status→provider mapping tables and the wire schema legitimately enumerate every status;
      // they define the VOCABULARY, which is a different thing from the activity policy over it.
      if (
        rel.startsWith(join("lib", "pm-sync")) ||
        rel.startsWith(join("lib", "api")) ||
        rel.startsWith(join("lib", "meetings")) ||
        rel.startsWith(join("lib", "ingest", "sources"))
      ) {
        continue;
      }
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(STATUS_LIST_RE)) hits.push(`${rel}: ${m[0].replace(/\s+/g, " ")}…`);
    }
  }
  return [...new Set(hits)].sort();
}

describe("guard: one activity policy", () => {
  it("no surface spells out its own task-status set", () => {
    expect(
      offenders(),
      `A task-status list outside lib/tasks/activity-policy is a second definition of "is this task ` +
        `active" — the drift H6 found. Import ACTIVE_STATUSES / OPEN_STATUSES (or isActiveStatus / ` +
        `isOpenStatus) instead:\n${offenders().join("\n")}`
    ).toEqual([]);
  });

  it("is non-vacuous: the pattern it looks for is detectable", () => {
    // Pins the regex. If a refactor broke it this guard would pass forever while the drift it exists to
    // catch walked back in — the same silent-failure shape it is guarding against.
    const drifted = `const IN_FLIGHT = new Set(["ready", "in_progress", "blocked"]);`;
    expect([...drifted.matchAll(STATUS_LIST_RE)]).toHaveLength(1);
    const singleCheck = `if (row.status === "done") return;`; // legitimate, must NOT match
    expect([...singleCheck.matchAll(STATUS_LIST_RE)]).toHaveLength(0);
    // Shapes a refactor could plausibly reach for — each must still be caught.
    for (const drift of [
      `new Set<TaskStatusValue>(["ready", "in_progress"])`,
      `const X = ["in_progress", "blocked"] as const;`,
      `.in("status", ["ready", "in_progress"])`,
      "const X = new Set([\n  \"ready\",\n  \"in_progress\",\n]);",
      "const X = [`ready`, `in_progress`];",
    ]) {
      expect([...drift.matchAll(STATUS_LIST_RE)], drift).toHaveLength(1);
    }
    // Composing FROM the policy is the encouraged pattern, not drift.
    const composed = `new Set([...ACTIVE_STATUSES, "ready"])`;
    expect([...composed.matchAll(STATUS_LIST_RE)]).toHaveLength(0);
  });

  it("keeps the two sets in the relationship the doc claims (OPEN ⊃ ACTIVE, and ready is the only delta)", () => {
    for (const s of ACTIVE_STATUSES) expect(OPEN_STATUSES.has(s)).toBe(true);
    expect([...OPEN_STATUSES].filter((s) => !ACTIVE_STATUSES.has(s))).toEqual(["ready"]);
    // `backlog`/`done` are out of both — the product rule the surfaces exist to express.
    for (const set of [ACTIVE_STATUSES, OPEN_STATUSES]) {
      expect(set.has("backlog")).toBe(false);
      expect(set.has("done")).toBe(false);
    }
  });
});
