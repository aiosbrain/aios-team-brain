import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * SINGLE-SOURCE attribution guard. "Who did the work on an item" must resolve through the ONE oracle —
 * `lib/attribution/contributor-credit.resolveItemCredit(Ids)` (evidence-gated over `item_versions`,
 * connector-excluded, lock-aware) — so every consuming surface (timeline, arcs, admin, `/api/v1`) agrees
 * and can't drift as teams scale (the reassignment + co-authorship divergence, which grows with team
 * size). This guard fails the build if a CONSUMER file under `lib/dashboard/**` or `lib/graph/**`
 * attributes work by reading raw `items.member_id` itself instead of calling the oracle.
 *
 * The oracle + the identity/attribution resolvers themselves live in `lib/attribution` and are NOT
 * scanned (they legitimately read `member_id` — they ARE the source). See docs/design/
 * attribution-oracle-unification.md.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "lib", "dashboard"), join(ROOT, "lib", "graph")];

// A file that READS item ownership: it queries `items` (builder `.from("items")` or raw SQL `from items`)
// AND references `member_id` — in CODE (comments stripped). That's the owner-based attribution smell.
const READS_ITEMS = /\.from\(\s*["']items["']\s*\)|from\s+items\b/i;
const REFS_MEMBER_ID = /member_id/;

// Allowlisted consumers (posix path suffixes):
//   • work-timeline.ts — MIGRATED: attributes via `resolveItemCreditIds` (primaryId). Its remaining
//     `member_id` refs are the not-null prefetch prefilter, the Slack per-participant leg (its own
//     evidence-gated credit), and the oracle-fallback — all legitimate.
//   • human-actors.ts — pre-existing owner-based event attribution (feeds /api/brain/events). Documented
//     exception; migrating it onto the oracle is a tracked fast-follow.
const ALLOW = ["lib/dashboard/work-timeline.ts", "lib/graph/human-actors.ts"];

const posix = (f: string): string => f.replaceAll("\\", "/");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/([^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(p, out);
    else if ((p.endsWith(".ts") || p.endsWith(".tsx")) && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(d));
const ownerReaders = files.filter((f) => {
  const code = stripComments(readFileSync(f, "utf8"));
  return READS_ITEMS.test(code) && REFS_MEMBER_ID.test(code);
});

describe("attribution single-source guard", () => {
  it("scans a non-trivial number of consumer files (guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("the detector actually fires (the migrated timeline IS an items+member_id reader)", () => {
    // If this stops matching, the detector has silently broken and the guard below is a no-op.
    expect(ownerReaders.some((f) => posix(f).endsWith("lib/dashboard/work-timeline.ts"))).toBe(true);
  });

  it("no CONSUMER reads item ownership by raw member_id outside the allowlist — use resolveItemCredit(Ids)", () => {
    const offenders = ownerReaders
      .map(posix)
      .filter((f) => !ALLOW.some((a) => f.endsWith(a)));
    expect(offenders).toEqual([]);
  });
});
