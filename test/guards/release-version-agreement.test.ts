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
 * nothing pinned them to each other — `package.json` sat at `0.10.0` for 23 days and the entire
 * v0.11.0+v0.12.0 interval without a single check noticing. (No commit count here: the first draft
 * said 168, measured days earlier, and it was 172 by the time it was written.)
 *
 * WHY THEY PARSE JSON RATHER THAN MATCH TEXT. Measured: a grep for `">=0.10.0"` matches **14**
 * unrelated dependency engine constraints inside `package-lock.json` (an earlier draft of this comment
 * said eight — counted by eye rather than by grep, which is the exact habit these guards exist to
 * replace). A text-matching guard would have been noise on its first run, and noise is how a guard
 * gets deleted.
 */

const ROOT = join(__dirname, "..", "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

/** Every place the Node application's version is written. NOT `ingestion/pyproject.toml`: that is a
 *  separately packaged sidecar with its own versioning (`ingestion/NOTICE`), and forcing it to match
 *  would be inventing a coupling that does not exist. */
type PkgLike = { version?: unknown };
type LockLike = { version?: unknown; packages?: Record<string, { version?: unknown } | undefined> };

/** The READ, split from the FILES so a test can perturb the inputs and prove each label reads the
 *  field it names. `versionSites()` below is the only production-shaped caller. */
function versionSitesFrom(pkg: PkgLike, lock: LockLike): { where: string; version: unknown }[] {
  return [
    { where: "package.json .version", version: pkg?.version },
    { where: "package-lock.json .version", version: lock?.version },
    { where: 'package-lock.json .packages[""].version', version: lock?.packages?.[""]?.version },
  ];
}

function versionSites(): { where: string; version: unknown }[] {
  return versionSitesFrom(readJson("package.json"), readJson("package-lock.json"));
}

/** `vX.Y.Z` ordered by number, never by string — `v0.9.0` sorts after `v0.10.0` as text. */
function newestDeclared(tags: readonly string[]): string {
  const CORE = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
  // REJECT, don't filter. Silently dropping a malformed declaration (a `v0.13.0-rc.1`) would let it sit
  // in DEFAULT_TAGS while this guard cheerfully agreed about a different tag — review found that hole.
  const malformed = tags.filter((t) => !CORE.test(t));
  if (malformed.length > 0) throw new Error(`DEFAULT_TAGS carries a non-release tag: ${malformed.join(", ")}`);
  const rank = (t: string) => t.slice(1).split(".").map(Number);
  return [...tags]
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
  // Anchored on what may FOLLOW the bracket too: `## [0.12.0]garbage` is not a release heading, and the
  // first spelling accepted it. Either end-of-line or a date delimiter.
  //
  // ANY dash, not just this file's em dash. Keep-a-Changelog's own spelling is an ASCII hyphen, so a
  // contributor writing `## [0.13.0] - 2026-09-01` would have reddened a guard for being conventional.
  // Widening costs nothing — `\]` still does the anti-collision work, so `0.1` never matches `[0.12.0]`.
  //
  // FENCED BLOCKS ARE NOT THE DOCUMENT. A `## [0.12.0]` line inside a ``` example is prose about a
  // heading, not a heading; accepting it would let the guard pass on a release whose real section had
  // been deleted, while an illustration stood in for it. Codex found that.
  return new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\](?:\\s*$|[ \\t]*[—–-])`, "m").test(
    stripFences(md)
  );
}

/** Blank out ``` / ~~~ fenced regions, preserving line count so `^`/`$` anchors keep their meaning. */
function stripFences(md: string): string {
  let inFence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      const open = /^\s*(```+|~~~+)/.exec(line);
      if (inFence === null && open) {
        inFence = open[1][0];
        return "";
      }
      if (inFence !== null) {
        const close = /^\s*(```+|~~~+)/.exec(line);
        if (close && close[1][0] === inFence) inFence = null;
        return "";
      }
      return line;
    })
    .join("\n");
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

  it("pins WHICH three sites are read — dropping one must not read as agreement", () => {
    // Both reviewers found this: the previous non-vacuity test asserted Set semantics over hardcoded
    // literals and shared no code path with versionSites(). Delete a site from the array and every
    // assertion stayed green while that lockfile field drifted freely. Pin the identities and the count.
    expect(versionSites().map((s) => s.where)).toEqual([
      "package.json .version",
      "package-lock.json .version",
      'package-lock.json .packages[""].version',
    ]);
  });

  it("each label reads the field it NAMES — perturb the input, not the output", () => {
    // BOTH REVIEWERS, round 2. The previous two attempts pinned the wrong thing: one compared label
    // strings, the other perturbed the reader's OUTPUT — so aliasing a site to a different field while
    // keeping its label (`version: pkg.version` under the `.packages[""]` label) survived every test,
    // and the lockfile field it claims to watch could then drift freely. That is precisely the
    // half-cut release this guard exists to prevent, so the perturbation has to go in the INPUT and
    // come out at the matching label.
    const site = (sites: { where: string; version: unknown }[], where: string) =>
      sites.find((s) => s.where === where)?.version;
    const pkg = { version: "1.0.0" };
    const lock = { version: "2.0.0", packages: { "": { version: "3.0.0" } } };
    const sites = versionSitesFrom(pkg, lock);
    expect(site(sites, "package.json .version")).toBe("1.0.0");
    expect(site(sites, "package-lock.json .version")).toBe("2.0.0");
    expect(site(sites, 'package-lock.json .packages[""].version')).toBe("3.0.0");
    // Three DISTINCT values, so no two sites can be aliased to each other and still pass.
    expect(new Set(sites.map((s) => s.version)).size).toBe(3);
    // …and a site that goes missing surfaces as undefined rather than borrowing a neighbour's value.
    expect(site(versionSitesFrom(pkg, { version: "2.0.0" }), 'package-lock.json .packages[""].version')).toBeUndefined();
  });

  it("is NON-VACUOUS: each real site, broken alone, breaks agreement", () => {
    const real = versionSites().map((s) => String(s.version));
    expect(new Set(real).size, "the repo itself must agree").toBe(1);
    for (let i = 0; i < real.length; i += 1) {
      const broken = [...real];
      broken[i] = "9.9.9";
      expect(new Set(broken).size, `${versionSites()[i].where} must be detectable alone`).toBeGreaterThan(1);
    }
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

  it("REJECTS a non-release tag rather than filtering it away", () => {
    // Fable, round 2: reverting this to the old silent `.filter` kept all 38 tests green — the fold's
    // own fix was pinned by nothing. The exposure is concrete: with `v0.13.0-rc.1` sitting in
    // DEFAULT_TAGS, a filtering reader agrees cheerfully about v0.12.0 while an undeclared-but-listed
    // tag rides along, and the live-list legality check that would otherwise catch it is tag-gated and
    // SKIPS on CI's tagless checkout. This assertion is the only always-running check on that path.
    expect(() => newestDeclared(["v0.12.0", "v0.13.0-rc.1"])).toThrow(/non-release tag/);
    expect(() => newestDeclared(["v0.12.0", "0.13.0"])).toThrow(/non-release tag/);
    expect(() => newestDeclared(["v0.12.0", "v01.0.0"])).toThrow(/non-release tag/);
    // …and it names the offender, so the failure is actionable rather than a bare throw.
    expect(() => newestDeclared(["v0.12.0", "v0.13.0-rc.1"])).toThrow(/v0\.13\.0-rc\.1/);
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
    // …and a heading that only looks like one.
    expect(changelogHasVersion("## [0.12.0]garbage", "0.12.0"), "malformed heading").toBe(false);
    expect(changelogHasVersion("## [0.1] — x\n", "0.1"), "a real short heading still matches").toBe(true);
    // An ASCII-hyphen heading is Keep-a-Changelog's own spelling — it must not red the guard.
    expect(changelogHasVersion("## [0.13.0] - 2026-09-01\n", "0.13.0"), "ASCII hyphen").toBe(true);
    // …but a heading that is only an EXAMPLE inside a fence is not a section (Codex, round 2).
    expect(
      changelogHasVersion("# Changelog\n\n```md\n## [0.12.0] — example\n```\n", "0.12.0"),
      "a fenced illustration is not a section"
    ).toBe(false);
    // …and the fence stripper must not eat the document around it.
    expect(
      changelogHasVersion("```md\n## [0.9.9] — example\n```\n\n## [0.12.0] — 2026-08-26\n", "0.12.0"),
      "a real heading after a fence still matches"
    ).toBe(true);
    // The real heading punctuation, which a `] - ` pattern would miss.
    expect(md).toMatch(/^## \[0\.11\.0\] — /m);
  });

  it("keeps an [Unreleased] HEADING for the next cycle — presence, not emptiness (criterion 6)", () => {
    // Dating a section without leaving one behind means the next contributor invents a new heading,
    // and the guard above starts passing against a section nobody is adding to.
    const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(md).toMatch(/^## \[Unreleased\]$/m);
  });

  it("reads the version from package.json, not a literal — so next release needs no edit here", () => {
    const src = readFileSync(join(__dirname, "release-version-agreement.test.ts"), "utf8");
    // The assertions must not hardcode the shipping version. `0.11.0`/`0.99.0`/`0.13.0` above are
    // changelog fixtures, and the `v0.12.0` literals are ordering/reject fixtures — none of them is the
    // value under test. (An earlier draft of this comment cited "the synthetic triple", which a later
    // fold had already deleted; a comment describing code that is gone is the drift these guards exist
    // to catch, one level up.)
    expect(src).toMatch(/readJson\("package\.json"\)\.version/);
  });
});
