import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Postgres TLS single-owner guard. Before `lib/db/pg/ssl.mjs`, eleven call sites each hand-rolled
 * `ssl: { rejectUnauthorized: false }` — so the server certificate was verified NOWHERE, and pinning
 * a CA would have meant finding and fixing every one of them (and the next one someone adds).
 * Every pg connection now takes its `ssl` from the helper; this fails the build if a TLS
 * verification knob reappears anywhere else in app/lib/scripts/docker.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts", "docker"];
const OWNER = join("lib", "db", "pg", "ssl.mjs");
const FORBIDDEN = /rejectUnauthorized|checkServerIdentity/;

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

  it("is not vacuous: the owner itself is scanned and does contain the knob", () => {
    const files = walk(join(ROOT, "lib")).map((abs) => abs.slice(ROOT.length + 1));
    expect(files).toContain(OWNER);
    expect(FORBIDDEN.test(readFileSync(join(ROOT, OWNER), "utf8"))).toBe(true);
  });
});
