import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Guard for brain-api 1.13 / AIO-537 (CLAUDE.md §2.2 — one rule + a build-failing guard beats
 * discipline you have to remember).
 *
 * `tasks.raw_status` holds the ORIGINAL unmapped markdown status string that produced the CURRENT
 * `tasks.status` — a workspace pushing `todo` stores `status='backlog', raw_status='todo'`
 * (`normalizeTaskStatus`). The 1.13 sync-origin return leg hands `raw_status` to the workspace so
 * it can tell a real brain-side change from the brain merely normalizing the push: if
 * `raw_status` still equals the local cell, the client must NOT clobber the author's word.
 *
 * That guard only holds if EVERY authoritative status write clears `raw_status`. It was already
 * missed once per writer: the Linear inbound apply, the dashboard board move, work-event
 * completion, the meetings bulk apply. Any one of them left stale makes the return leg refuse a
 * real change and the markdown sits on `todo` forever — the exact drift AIO-537 closes.
 *
 * Only `lib/ingest/tasks.ts` (materializeTasks) may SET a non-null raw_status: it is the sole
 * writer of the pushed markdown value.
 */

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "lib"];
const SKIP = new Set(["node_modules", ".next", "dist"]);
// The one legal writer of a non-null raw_status (the push path that also computes it).
const RAW_STATUS_OWNER = "lib/ingest/tasks.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const entry of readdirSync(abs)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(abs, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  visit(path.join(ROOT, dir));
  return out;
}

/** `.from("tasks") … .update({ … })` object literals, and raw `update tasks set …` statements. */
function statusWrites(text: string): string[] {
  const found: string[] = [];
  // Split on `.from(` so each segment belongs to exactly ONE table: a `.update({…})` inside a
  // `"tasks")` segment is a tasks write, and a later update on a different table (e.g.
  // work_events' own `status`) can never be mis-attributed. Distance-based pairing got both wrong.
  for (const segment of text.split(/\.from\(/)) {
    if (!/^\s*["']tasks["']\s*\)/.test(segment)) continue;
    const m = segment.match(/\.update\(\s*\{([\s\S]{0,400}?)\}\s*\)/);
    if (m) found.push(m[1]);
  }
  const raw = /update\s+tasks\s+set\s+([^`;]{0,300})/g;
  for (const m of text.matchAll(raw)) found.push(m[1]);
  // `status:` / `status =` (raw SQL) AND the ES shorthand `{ status, … }` — the shorthand is how
  // the dashboard board move writes it, and an earlier draft of this guard missed exactly that.
  return found.filter((body) => /(^|[\s,({])status\s*([:=,}]|$)/.test(body));
}

describe("every authoritative tasks.status write clears raw_status (AIO-537)", () => {
  const files = SCAN_DIRS.flatMap(sourceFiles);

  it("scans a non-trivial surface (the guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(50);
    const writers = files.filter((f) => statusWrites(readFileSync(f, "utf8")).length > 0);
    expect(writers.length).toBeGreaterThanOrEqual(3);
  });

  it("finds no status write that leaves raw_status behind", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (rel === RAW_STATUS_OWNER) continue;
      for (const body of statusWrites(readFileSync(file, "utf8"))) {
        if (!/raw_status/.test(body)) offenders.push(`${rel}: ${body.trim().slice(0, 120)}`);
      }
    }
    expect(
      offenders,
      `These writes set tasks.status without clearing raw_status. Add \`raw_status: null\` ` +
        `(or \`raw_status = null\` in raw SQL) — otherwise the brain-api 1.13 sync-origin return ` +
        `leg reads the change as a normalization echo and never reaches the workspace markdown.`,
    ).toEqual([]);
  });
});
