import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Postgres TLS single-owner guard. Before `lib/db/pg/ssl.mjs`, eleven call sites each hand-rolled
 * `ssl: { rejectUnauthorized: false }` — so the server certificate was verified NOWHERE, and pinning
 * a CA would have meant finding and fixing every one of them (and the next one someone adds).
 * Every pg connection now takes its `ssl` from the helper; this fails the build if a TLS
 * verification knob reappears anywhere else in app/lib/scripts/docker, AND if a file constructs a pg
 * Client/Pool without importing the helper (a client that passes no `ssl` at all would otherwise
 * slip past the first check and connect in plaintext with PG_CA_CERT set).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts", "docker"];
const OWNER = join("lib", "db", "pg", "ssl.mjs");
const FORBIDDEN = /rejectUnauthorized|checkServerIdentity/;
const CONSTRUCTS_PG = /new\s+(?:pg\.)?(?:Client|Pool)\s*\(/;
const IMPORTS_HELPER = /lib\/db\/pg\/ssl\.mjs/;
// Files that construct a pg client WITHOUT the helper, each with the reason it is deliberate.
const NOT_ROUTED = new Map<string, string>([
  // The staging copy/refresh plane parses every target through its own canonical contract
  // (staging-ops/postgres-target.mjs: allowlisted ssl params, internal-host only) and talks to TWO
  // databases with different CAs in one process, so one PG_CA_CERT cannot describe it. Tracked as a
  // follow-up; until then its TLS is whatever its target URL says.
  [join("scripts", "staging-ops", "exporter.mjs"), "staging-ops target contract (two databases)"],
  [join("scripts", "staging-ops", "importer.mjs"), "staging-ops target contract (two databases)"],
  [join("scripts", "staging-ops", "staging-pair-fixture.mjs"), "local docker staging-pair fixture"],
  // Local scratch-database harnesses: they only ever dial the throwaway test Postgres.
  [join("scripts", "migrate-from-existing.mjs"), "DATABASE_TEST_URL scratch databases"],
  [join("scripts", "debt-intake-migration-proof.mjs"), "127.0.0.1 docker scratch databases"],
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(p) && !/\.d\.mts$/.test(p)) out.push(p);
  }
  return out;
}

describe("Postgres TLS has one owner (lib/db/pg/ssl.mjs)", () => {
  it("no file outside the helper sets rejectUnauthorized / checkServerIdentity", () => {
    const offenders = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
      .filter((abs) => abs.slice(ROOT.length + 1) !== OWNER)
      .filter((abs) => FORBIDDEN.test(readFileSync(abs, "utf8")))
      .map((abs) => abs.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("every file that constructs a pg Client/Pool takes its TLS from the helper (or is a reviewed exception)", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).map((abs) => abs.slice(ROOT.length + 1));
    const constructing = files.filter((rel) => rel !== OWNER && CONSTRUCTS_PG.test(readFileSync(join(ROOT, rel), "utf8")));
    const unrouted = constructing.filter(
      (rel) => !NOT_ROUTED.has(rel) && !IMPORTS_HELPER.test(readFileSync(join(ROOT, rel), "utf8"))
    );
    expect(unrouted).toEqual([]);
    // The exception list cannot rot: every entry must still exist and still construct a client.
    for (const rel of NOT_ROUTED.keys()) expect(constructing, `stale NOT_ROUTED entry ${rel}`).toContain(rel);
    // Non-vacuous: the real call sites are seen.
    expect(constructing).toEqual(expect.arrayContaining([join("lib", "db", "pg", "pool.ts"), join("docker", "bootstrap.mjs")]));
  });

  it("is not vacuous: the owner itself is scanned and does contain the knob", () => {
    const files = walk(join(ROOT, "lib")).map((abs) => abs.slice(ROOT.length + 1));
    expect(files).toContain(OWNER);
    expect(FORBIDDEN.test(readFileSync(join(ROOT, OWNER), "utf8"))).toBe(true);
  });
});
