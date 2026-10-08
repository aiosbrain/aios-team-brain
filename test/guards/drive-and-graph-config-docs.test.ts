import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public configuration docs must name what the brain actually reads.
 *
 * WHY GUARD PROSE. Two operator-facing facts lived only in code and were wrong or missing in the
 * README and `.env.example`:
 *   - Google Drive OAuth and Picker are switched on by five `GOOGLE_DRIVE_*` variables that neither
 *     file mentioned, while the README still said Drive credentials never reach the brain.
 *   - `GRAPHITI_URL` was documented as the whole graph switch, but provenance-checked graph reads go
 *     directly to Neo4j and FAIL CLOSED without `NEO4J_URL`; the README called that variable a
 *     learning-panel nicety.
 * The variable list is derived from the source, so a sixth variable read tomorrow reddens this until
 * it is documented; the literal list below is the non-vacuity pin (a scan that finds nothing would
 * otherwise pass every `for` loop).
 *
 * WHAT THIS DOES NOT CLAIM: that an OAuth client is registered, that a credential authenticates, or
 * that any deployment sets these. It checks that the docs still SAY the right thing, with no value.
 */

const ROOT = path.join(__dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const README = read("README.md");
const ENV_EXAMPLE = read(".env.example");

const SOURCE_ROOTS = ["app", "lib", "components"];
const EXTENSIONS = new Set([".ts", ".tsx"]);

function filesBelow(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) out.push(...filesBelow(full));
    else if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
  return out;
}

/** Every `GOOGLE_DRIVE_*` variable the brain reads from its own environment. */
function driveVariablesRead(): string[] {
  const names = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for (const file of filesBelow(path.join(ROOT, root))) {
      for (const hit of readFileSync(file, "utf8").match(/process\.env\.GOOGLE_DRIVE_[A-Z0-9_]+/g) ?? []) {
        names.add(hit.slice("process.env.".length));
      }
    }
  }
  return [...names].sort();
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, `"${start}" must exist`).toBeGreaterThanOrEqual(0);
  expect(to, `"${end}" must follow "${start}"`).toBeGreaterThan(from);
  return text.slice(from, to);
}

const DRIVE_VARIABLES = driveVariablesRead();

describe("guard: every Google Drive variable the brain reads is documented, without a value", () => {
  it("the source scan finds exactly the five variables the OAuth routes and the Admin page read", () => {
    expect(DRIVE_VARIABLES).toEqual([
      "GOOGLE_DRIVE_APP_ID",
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_OAUTH_REDIRECT",
      "GOOGLE_DRIVE_PICKER_API_KEY",
    ]);
  });

  it(".env.example offers each one as a commented assignment with NO value, and never as an active one", () => {
    for (const name of DRIVE_VARIABLES) {
      expect(ENV_EXAMPLE, `${name} must be offered, commented and empty`)
        .toMatch(new RegExp(`^# ${name}=[ \\t]*(#.*)?$`, "m"));
      expect(ENV_EXAMPLE, `${name} must not be an active assignment`).not.toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("the README environment reference lists each one", () => {
    const reference = between(README, "## 3. Environment variable reference", "## 4. ");
    for (const name of DRIVE_VARIABLES) {
      expect(reference, `${name} must be in the environment reference`).toContain(`\`${name}\``);
    }
  });

  it("the README Drive section names each one, the callback the app really serves, and no credential", () => {
    const drive = between(README, "#### Google Drive configuration", "## 2. Setup");
    for (const name of DRIVE_VARIABLES) {
      expect(drive, `${name} must be explained in the Drive section`).toContain(`\`${name}\``);
    }
    // The documented redirect is a route that exists, not a path someone remembered.
    expect(statSync(path.join(ROOT, "app", "api", "auth", "gdrive", "callback", "route.ts")).isFile()).toBe(true);
    expect(drive).toContain("<APP_URL>/api/auth/gdrive/callback");
    // Both auth modes, and where each credential lives.
    expect(drive).toMatch(/stored \*\*encrypted in the brain\*\*/);
    expect(drive).toMatch(/give the JSON key to the \*sidecar\s+only\*/);
    // Shapes of real Google credentials: a client secret, an API key, a client id, a private key.
    expect(drive).not.toMatch(/GOCSPX-|AIza[0-9A-Za-z_-]{10,}|\.apps\.googleusercontent\.com|-----BEGIN/);
  });

  it("the README no longer says sidecar credentials never reach the brain without the Drive OAuth exception", () => {
    const sidecar = between(README, "### 2.6 ", "### 2.7 ");
    expect(sidecar).toMatch(/never touch the brain\. \*\*Google Drive OAuth is the one exception:\*\*/);
  });
});

describe("guard: the docs say NEO4J_URL is required for graph reads once GRAPHITI_URL is set", () => {
  it("the behaviour the docs describe is still the behaviour: an unconfigured Neo4j read fails closed", () => {
    // If this stops matching, the fail-closed read moved or changed — re-read the docs below against
    // the new code rather than loosening the pattern.
    expect(read("lib/graph/provenance-read.ts"))
      .toMatch(/if \(!neo4jConfigured\(\)\) \{\s*throw new GraphProvenanceUnavailableError\(/);
  });

  it("the environment reference rows carry the requirement, anchored inside each row", () => {
    const rows = README.split("\n");
    const graphiti = rows.find((line) => line.startsWith("| `GRAPHITI_URL` |")) ?? "";
    const neo4j = rows.find((line) => line.startsWith("| `NEO4J_URL` ")) ?? "";
    expect(graphiti, "the GRAPHITI_URL row must exist").not.toBe("");
    expect(neo4j, "the NEO4J_URL row must exist").not.toBe("");
    expect(graphiti).toMatch(/Not sufficient on its own/);
    expect(graphiti).toContain("`NEO4J_URL`");
    expect(neo4j).toContain("**Required whenever `GRAPHITI_URL` is set:**");
    expect(neo4j).toMatch(/fail closed/);
    expect(neo4j, "must not restate the claim it corrects").not.toMatch(/Direct bolt reads for the learning panel \|/);
  });

  it("the setup section and .env.example say GRAPHITI_URL alone is not enough", () => {
    const setup = between(README, "**2.8c. Point the app at it.**", "**2.8d.");
    expect(setup).toContain("**`GRAPHITI_URL` alone is not enough — set `NEO4J_URL` with it.**");
    expect(setup).toMatch(/\*\*fail closed\*\*/);
    expect(setup).toMatch(/direct `\/api\/v1\/graph-query` reads remain available\s+when `NEO4J_URL` is configured/);
    expect(ENV_EXAMPLE).toMatch(/^# NEO4J_URL is REQUIRED whenever GRAPHITI_URL is set/m);
    expect(ENV_EXAMPLE).toMatch(/FAIL CLOSED/);
  });
});
