/**
 * Guard: the license dependency-direction rule (RELIC-1).
 *
 * This repository carries two licenses. The server is AGPL-3.0-only; `ingestion/` and
 * `graphiti/` are deliberate Apache-2.0 pockets (see LICENSING.md). That split is only
 * safe in ONE direction:
 *
 *     Apache-2.0 code must NEVER import from AGPL-3.0 code.
 *     Apache -> AGPL is fine. AGPL -> Apache is a license violation.
 *
 * The reason is that the AGPL is contagious across a combined program and Apache-2.0 is
 * not. An AGPL module pulled into an Apache-2.0 package makes that package's Apache grant
 * undeliverable — we would be promising permissions we cannot grant.
 *
 * The failure mode this exists to catch is not today's code (which is clean) but someone
 * adding one convenient import eighteen months from now. LICENSING.md and CONTRIBUTING.md
 * both state the rule is enforced in CI; `npm test` runs in CI, so this file is what makes
 * that statement true rather than aspirational.
 *
 * It also pins the licensing METADATA, because the rule is meaningless if a directory
 * quietly stops being Apache-licensed: the moment `ingestion/LICENSE` disappears or the
 * root manifest stops saying AGPL-3.0-only, "Apache must not import AGPL" no longer
 * describes this repo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..");

/** Directories licensed Apache-2.0 — the permissive side that must stay import-clean. */
const APACHE_DIRS = ["ingestion", "graphiti"] as const;

/** Top-level directories that are AGPL-3.0-only. Importing any of these from an
 *  Apache dir is the violation. `test/` is included: it is AGPL too. */
const AGPL_DIRS = ["lib", "app", "components", "scripts", "postgres", "test"] as const;

/** Never walk into build output, virtualenvs, or vendored trees. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".git",
  "egg-info",
]);

/** Only files that can express an import. Docs and license files are exempt by
 *  construction — LICENSING.md necessarily *names* the AGPL directories. */
const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".toml"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.endsWith(".egg-info")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/**
 * Import-ish references to an AGPL directory, in the forms a real violation would take:
 *   Python   `from lib.x import y`, `import lib.x`, `sys.path.append("../lib")`
 *   JS/TS    `from "../lib/x"`, `require("../../app/y")`, `import("../scripts/z")`
 *   shell    sourcing or running a path that escapes into an AGPL dir
 * Anchored on a path escape (`../`) or a bare module import, so that an ordinary word
 * ("this app", "the lib") in a comment cannot trip it.
 */
function violations(source: string): string[] {
  const alt = AGPL_DIRS.join("|");
  const patterns = [
    // Python: `from lib...` / `import lib...` at statement position
    new RegExp(`^\\s*(?:from|import)\\s+(?:${alt})(?:[.\\s]|$)`, "gm"),
    // Any relative path that escapes upward into an AGPL directory
    new RegExp(`(?:\\.\\./)+(?:${alt})/`, "g"),
    // Bare specifier import/require of an AGPL dir (JS/TS)
    new RegExp(`(?:from|require\\(|import\\()\\s*["'\`](?:${alt})/`, "g"),
    // The repo's own TS path alias into AGPL code
    new RegExp(`["'\`]@/(?:${alt})/`, "g"),
  ];
  const hits: string[] = [];
  for (const re of patterns) for (const m of source.matchAll(re)) hits.push(m[0].trim());
  return hits;
}

describe("guard: Apache-2.0 directories must not import from AGPL-3.0 code", () => {
  it("no file under an Apache-2.0 directory imports from an AGPL-3.0 directory", () => {
    const found: string[] = [];
    for (const dir of APACHE_DIRS) {
      for (const file of walk(join(REPO, dir))) {
        const hits = violations(readFileSync(file, "utf8"));
        for (const h of hits) found.push(`${relative(REPO, file)} -> ${h}`);
      }
    }
    expect(
      found,
      "An Apache-2.0 directory imports AGPL-3.0 code. This makes that directory's Apache " +
        "grant undeliverable — we would be promising permissions we cannot grant. Either " +
        "move the shared code into the Apache directory, or reach it over HTTP as the " +
        "ingestion sidecar already does. See LICENSING.md.",
    ).toEqual([]);
  });

  // The rule above only means something while these directories really are Apache-licensed
  // and the root really is AGPL. Pin that, so the guard cannot go quietly vacuous.
  it.each(APACHE_DIRS)("%s/ still carries its own Apache-2.0 LICENSE and NOTICE", (dir) => {
    const license = readFileSync(join(REPO, dir, "LICENSE"), "utf8");
    const notice = readFileSync(join(REPO, dir, "NOTICE"), "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("Chetan Nandakumar and John Ellison");
    expect(notice).toContain("Chetan Nandakumar and John Ellison");
  });

  it("the root manifest declares AGPL-3.0-only and the sidecar declares Apache-2.0", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(readFileSync(join(REPO, "ingestion", "pyproject.toml"), "utf8")).toContain(
      'license = { text = "Apache-2.0" }',
    );
  });

  it("the root LICENSE is AGPL-3.0-only and the prior MIT text is preserved", () => {
    const root = readFileSync(join(REPO, "LICENSE"), "utf8");
    expect(root).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(root).toContain("Chetan Nandakumar and John Ellison");

    // AGPL-3.0-only, never -or-later. Scope this to OUR grant header — the verbatim
    // license body that follows contains the FSF's "How to Apply These Terms" appendix,
    // which legitimately shows the "or (at your option) any later version" template.
    // Asserting over the whole file would fail on the upstream text itself.
    const header = root.split("=".repeat(80))[0];
    // "Free Software Foundation" wraps across a line break in the header, so match the
    // half that carries the version restriction.
    expect(header).toContain("Software Foundation, version 3.");
    expect(header).not.toMatch(/at your option.*later version/s);

    expect(readFileSync(join(REPO, "LICENSE-MIT"), "utf8")).toContain("MIT License");
  });
});
