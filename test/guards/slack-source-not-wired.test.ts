import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * AIO-1170 activation guard: the internal Slack source-discovery entrypoint is NOT reachable from
 * any execution path yet.
 *
 * It performs real provider requests against a real integration's token, and the slice it belongs to
 * is deliberately incomplete — nothing publishes an item, nothing migrates a namespace, no capacity
 * gate has been certified. Wiring it into the runner, the scheduler, manual sync or an admin action
 * would turn "the code exists" into "the code runs against a production workspace", which is the one
 * step this build must not take by accident.
 *
 * This is a REAL failure mode, not ceremony: the modules it guards are named exactly like the ones
 * `lib/ingest/run.ts` already imports, and the whole packet is a drop-in replacement for that path.
 * Deleting this guard is the deliberate act that activation requires.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_MODULES = ["slack-source-discovery", "slack-channel-state", "slack-source-binding"];
/** Every directory an app REQUEST or a scheduled tick can reach. */
const EXECUTION_ROOTS = ["app", "lib", "scripts", "instrumentation.ts"];
/** The one place the new modules may be imported from: their own family and their tests. */
const ALLOWED = /^lib[/\\]ingest[/\\]slack-(source-discovery|channel-state|source-binding)\.ts$/;

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

describe("the Slack source-discovery entrypoint is not wired to anything", () => {
  it("is imported by no runner, scheduler, route, action or script", () => {
    const files = EXECUTION_ROOTS.flatMap((entry) => {
      const p = join(ROOT, entry);
      try {
        return statSync(p).isDirectory() ? walk(p) : [p];
      } catch {
        return [];
      }
    });
    expect(files.length).toBeGreaterThan(100); // the scan is non-vacuous

    const importers = files.filter((file) => {
      const rel = file.slice(ROOT.length + 1);
      if (ALLOWED.test(rel)) return false;
      const src = readFileSync(file, "utf8");
      return SOURCE_MODULES.some((mod) =>
        new RegExp(`from\\s+["'][^"']*ingest/${mod}["']`).test(src)
      );
    });

    expect(importers.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
