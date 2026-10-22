import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// eMudhra CA compromise (2026-10-20): a Node that predates 22.23.4 / 24.22.1 / 26.12.1 trusts
// certificates forged with the compromised intermediates. These workflows carry a credential and
// run Node WITHOUT `npm ci`; the runner image's preinstalled Node has lagged the fix (ubuntu-24.04
// image 20261012 ships 22.23.3), so each must install a current Node and refuse an old one before
// its first `node` invocation.
const ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS = ["aios-work-sync", "pr-task-link", "staging-ops-image", "staging-ops-image-audit"];

describe("credential-carrying workflows refuse a pre-fix Node", () => {
  it.each(WORKFLOWS)("%s installs a current Node and floor-checks it before any other node step", (name) => {
    const text = readFileSync(path.join(ROOT, ".github", "workflows", `${name}.yml`), "utf8");
    const setup = text.indexOf("uses: actions/setup-node@");
    const floor = text.indexOf("run: node scripts/check-node-tls-floor.mjs");
    expect(setup).toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(setup);
    expect(text.slice(setup, floor)).toContain("check-latest: true");
    // The first line that invokes `node` (a `run: node …` step or a heredoc body) is the floor check.
    const firstNode = text.match(/^\s+(?:run: )?node(?:\s.*)?$/m);
    expect(firstNode?.[0].trim()).toBe("run: node scripts/check-node-tls-floor.mjs");
  });
});

describe("the floor check runs with no installed dependencies", () => {
  // Those workflows never run `npm ci`. A transitive import of an npm package (doctor.mjs gained
  // one: pg, via lib/db/pg/ssl.mjs) would fail every run with ERR_MODULE_NOT_FOUND, and a test run
  // from this checkout cannot see that because node_modules is right here.
  it("check-node-tls-floor.mjs and its imports resolve from a bare copy of scripts/", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tls-floor-"));
    try {
      for (const f of ["check-node-tls-floor.mjs", "node-tls-floor.mjs"]) {
        cpSync(path.join(ROOT, "scripts", f), path.join(dir, f));
      }
      const out = execFileSync(process.execPath, [path.join(dir, "check-node-tls-floor.mjs")], { cwd: dir, encoding: "utf8" });
      expect(out).toMatch(/^node TLS floor: node \d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("node-tls-floor.mjs imports nothing but node built-ins", () => {
    const text = readFileSync(path.join(ROOT, "scripts", "node-tls-floor.mjs"), "utf8");
    const specifiers = [...text.matchAll(/\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });
});
