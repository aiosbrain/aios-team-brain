import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TAGS } from "../../scripts/migrate-from-existing.mjs";

/**
 * RELPTR-2 — the three things a release must agree about, checked against each other.
 * Spec: `docs/design/release-pret6-upgrade-path.md`, Decision 5.
 *
 * WHY THESE THREE. A "half-cut release" is the failure: the version the app reports, the tag a user
 * pins, and the CHANGELOG heading disagreeing. Each is written by hand at a different moment, and
 * nothing pinned them to each other — `package.json` sat at `0.10.0` for 168 commits and 23 days
 * without a single check noticing.
 *
 * WHY THEY PARSE JSON RATHER THAN MATCH TEXT. Measured: a grep for `0.10.0` matches **eight**
 * unrelated `"node": ">=0.10.0"` engine constraints inside `package-lock.json`. A text-matching guard
 * would have been noise on its first run, and noise is how a guard gets deleted.
 */

const ROOT = join(__dirname, "..", "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

/** Every place the Node application's version is written. NOT `ingestion/pyproject.toml`: that is a
 *  separately packaged sidecar with its own versioning (`ingestion/NOTICE`), and forcing it to match
 *  would be inventing a coupling that does not exist. */
function versionSites(): { where: string; version: unknown }[] {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  return [
    { where: "package.json .version", version: pkg.version },
    { where: "package-lock.json .version", version: lock.version },
    { where: 'package-lock.json .packages[""].version', version: lock.packages?.[""]?.version },
  ];
}

/** `vX.Y.Z` ordered by number, never by string — `v0.9.0` sorts after `v0.10.0` as text. */
function newestDeclared(tags: readonly string[]): string {
  const rank = (t: string) => t.slice(1).split(".").map(Number);
  return [...tags]
    .filter((t) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(t))
    .sort((a, b) => {
      const [ax, ay, az] = rank(a);
      const [bx, by, bz] = rank(b);
      return ax - bx || ay - by || az - bz;
    })
    .at(-1)!;
}

/** Does the changelog carry a section for this version? Tolerant of the file's real punctuation —
 *  the headings use an EM DASH (`## [0.10.0] — 2026-08-03`), which a naive `- ` pattern misses. */
function changelogHasVersion(md: string, version: string): boolean {
  return new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(md);
}

describe("release agreement — the version's three sites (criteria 1, 2)", () => {
  it("all three agree", () => {
    const sites = versionSites();
    const distinct = new Set(sites.map((s) => String(s.version)));
    expect([...distinct], sites.map((s) => `${s.where}=${s.version}`).join(" | ")).toHaveLength(1);
  });

  it("each site is READ, so none can go missing and pass as agreement", () => {
    // A site that returns `undefined` would collapse into a single distinct value with the others only
    // if they were all undefined — but an absent lockfile path silently reading `undefined` while the
    // other two agree is exactly the shape that makes an equality check look green. Pin presence too.
    for (const s of versionSites()) {
      expect(s.version, `${s.where} must exist`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("is NON-VACUOUS: a disagreement at ANY single site is caught", () => {
    // Each site failing ALONE, against a synthetic pair — the real files are green, so without this
    // the assertion above proves only that today happens to be fine.
    const agree = ["0.12.0", "0.12.0", "0.12.0"];
    for (let i = 0; i < 3; i += 1) {
      const broken = [...agree];
      broken[i] = "0.11.0";
      expect(new Set(broken).size, `site ${i} must be detectable alone`).toBeGreaterThan(1);
    }
    expect(new Set(agree).size).toBe(1);
  });

  it("does NOT match text: the lockfile's engine constraints must not be mistaken for our version", () => {
    // The reason this guard parses. `"node": ">=0.10.0"` appears several times in package-lock.json.
    const lockText = readFileSync(join(ROOT, "package-lock.json"), "utf8");
    const engineHits = [...lockText.matchAll(/">=0\.10\.0"/g)].length;
    expect(engineHits, "the trap this guard exists to avoid should still be present").toBeGreaterThan(1);
    // …and none of them is a version site.
    expect(versionSites().every((s) => s.version !== ">=0.10.0")).toBe(true);
  });
});

describe("release agreement — the declared tag and the changelog (criteria 3, 4, 5)", () => {
  it("the newest DECLARED tag matches the version this tree ships as", () => {
    const version = readJson("package.json").version as string;
    expect(newestDeclared(DEFAULT_TAGS)).toBe(`v${version}`);
  });

  it("compares by SEMVER, not array position — a reordered list gives the same answer", () => {
    // `.at(-1)` on the raw array would let a harmless reordering disagree with `nextTagPolicy`, which
    // picks the semver maximum. Then the guard and the policy would name different pending releases.
    expect(newestDeclared(["v0.12.0", "v0.10.0", "v0.11.0"])).toBe("v0.12.0");
    expect(newestDeclared(["v0.9.0", "v0.10.0"])).toBe("v0.10.0"); // string sort would say v0.9.0
  });

  it("CHANGELOG.md carries a section for the version being shipped", () => {
    const version = readJson("package.json").version as string;
    const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelogHasVersion(md, version), `no "## [${version}]" section`).toBe(true);
  });

  it("is NON-VACUOUS, and tolerates the file's real em-dash headings", () => {
    const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelogHasVersion(md, "0.11.0"), "a version that IS there").toBe(true);
    expect(changelogHasVersion(md, "0.99.0"), "a version that is NOT").toBe(false);
    // The real heading punctuation, which a `] - ` pattern would miss.
    expect(md).toMatch(/^## \[0\.11\.0\] — /m);
  });

  it("keeps an empty [Unreleased] heading for the next cycle (criterion 6)", () => {
    // Dating a section without leaving one behind means the next contributor invents a new heading,
    // and the guard above starts passing against a section nobody is adding to.
    const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(md).toMatch(/^## \[Unreleased\]$/m);
  });

  it("reads the version from package.json, not a literal — so next release needs no edit here", () => {
    const src = readFileSync(join(__dirname, "release-version-agreement.test.ts"), "utf8");
    // The assertions must not hardcode the shipping version; `0.11.0`/`0.99.0` above are fixtures for
    // the non-vacuity check, and `0.12.0` appears only in the synthetic triple.
    expect(src).toMatch(/readJson\("package\.json"\)\.version/);
  });
});
