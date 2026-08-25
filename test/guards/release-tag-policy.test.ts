import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TAGS, nextTagPolicy } from "../../scripts/migrate-from-existing.mjs";

/**
 * RELPTR-1 — cutting a release used to be impossible without freezing the repo.
 * Spec: `docs/design/release-pointer-stable-branch.md`, criteria 1–9.
 *
 * THE DEADLOCK, because the assertions below only make sense against it. Two rules ran back to back
 * in `scripts/migrate-from-existing.mjs`:
 *
 *   - every declared tag must exist            → extend `DEFAULT_TAGS` first and the extension's own
 *                                                 PR throws `unknown git tag`
 *   - the newest existing tag must be declared → cut the tag first and EVERY open PR throws
 *                                                 `DEFAULT_TAGS is stale`, because this lane runs in
 *                                                 `ci.yml` on `pull_request`
 *
 * No ordering avoids a red window. The fix widens the first rule by EXACTLY ONE tag — the newest
 * declared one, i.e. a release being prepared — and the tests below are mostly about that boundary,
 * because a wider hole would delete the anti-rot property the staleness rule exists for.
 */

const ROOT = join(__dirname, "..", "..");
const REAL_TAGS = ["v0.10.0", "v0.9.0", "v0.8.0", "v0.7.0"]; // newest-first, as git reports them

describe("release tag policy — the prepared release (criteria 1, 2, 5)", () => {
  it("ALLOWS the newest declared tag to be absent, and says so instead of throwing", () => {
    const res = nextTagPolicy([...DEFAULT_TAGS, "v0.11.0"], REAL_TAGS);
    expect(res.pending).toBe("v0.11.0");
    expect(res.usable).toEqual(DEFAULT_TAGS);
    expect(res.notice).toMatch(/declared but not yet cut/);
  });

  it("THROWS on a hole in the MIDDLE — the fix must not hide a typo", () => {
    // The whole risk of widening rule one is that `v0.8.5` (never existed) reads as "pending" forever
    // and the lane silently stops upgrading from it. Only the newest may be absent.
    expect(() => nextTagPolicy(["v0.7.0", "v0.8.5", "v0.10.0"], REAL_TAGS)).toThrow(/unknown git tag: v0\.8\.5/);
  });

  it("picks the exempt tag by VERSION, not by list position", () => {
    // `v0.9.0` > `v0.10.0` under string sort. A list written out of order must not change which tag
    // is allowed to be missing, or the exemption moves under a harmless reformat.
    const res = nextTagPolicy(["v0.11.0", "v0.7.0", "v0.8.0", "v0.9.0", "v0.10.0"], REAL_TAGS);
    expect(res.pending).toBe("v0.11.0");
    expect(() => nextTagPolicy(["v0.11.0", "v0.9.5", "v0.10.0"], [...REAL_TAGS, "v0.11.0"])).toThrow(
      /unknown git tag: v0\.9\.5/
    );
  });
});

describe("release tag policy — the anti-rot rule survives (criteria 3, 4, 5)", () => {
  it("THROWS when a tag EXISTS that is newer than everything declared", () => {
    expect(() => nextTagPolicy(["v0.7.0", "v0.8.0"], REAL_TAGS)).toThrow(/DEFAULT_TAGS is stale: v0\.10\.0/);
  });

  it("is NON-VACUOUS against the repo's REAL tags: shipped list passes, a fictional release reddens it", () => {
    // Both directions against real data. A check that only ever passes is indistinguishable from one
    // that matches nothing — this repo has shipped that failure before.
    const realFromGit = execFileSync("git", ["tag", "--sort=-v:refname"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(realFromGit).toContain("v0.10.0");
    expect(() => nextTagPolicy(DEFAULT_TAGS, realFromGit)).not.toThrow();
    expect(() => nextTagPolicy(DEFAULT_TAGS, ["v0.99.0", ...realFromGit])).toThrow(/stale: v0\.99\.0/);
  });

  it("compares by version, so a newer tag cannot hide behind string ordering", () => {
    // `v0.9.0` sorts after `v0.10.0` as a string. If the stale check used string order it would miss
    // a real newer release, which is the exact silence the rule exists to prevent.
    expect(() => nextTagPolicy(["v0.9.0"], ["v0.10.0", "v0.9.0"])).toThrow(/stale: v0\.10\.0/);
  });

  it("each outcome fires ALONE for an input that triggers only it", () => {
    expect(nextTagPolicy(DEFAULT_TAGS, REAL_TAGS)).toEqual({ usable: DEFAULT_TAGS, pending: null, notice: null });
    expect(nextTagPolicy([...DEFAULT_TAGS, "v0.11.0"], REAL_TAGS).pending).toBe("v0.11.0");
    expect(() => nextTagPolicy(["v0.7.0", "v0.8.5", "v0.10.0"], REAL_TAGS)).toThrow(/unknown git tag/);
    expect(() => nextTagPolicy(["v0.7.0"], REAL_TAGS)).toThrow(/stale/);
  });
});

describe("release tag policy — the real corpus is MIXED (criterion 6)", () => {
  it("this repo has both annotated and lightweight tags, which is why nothing may compare raw ref ids", () => {
    // Measured, not assumed: v0.7.0/v0.9.0 are annotated (the ref names a tag OBJECT), v0.8.0/v0.10.0
    // are lightweight (the ref names the commit). Any future check that compares a tag's ref id to a
    // commit id would silently miss half the releases — so this pins the property that makes peeling
    // mandatory, next to the policy that will need it.
    const typeOf = (t: string) =>
      execFileSync("git", ["cat-file", "-t", t], { cwd: ROOT, encoding: "utf8" }).trim();
    const types = Object.fromEntries(["v0.7.0", "v0.8.0", "v0.9.0", "v0.10.0"].map((t) => [t, typeOf(t)]));
    expect(new Set(Object.values(types))).toEqual(new Set(["tag", "commit"]));
    // …and `--points-at` peels both, which is the one gathering idiom that is safe.
    const peeled = execFileSync("git", ["tag", "--points-at", "v0.9.0^{commit}"], { cwd: ROOT, encoding: "utf8" });
    expect(peeled).toContain("v0.9.0");
  });
});

describe("release tag policy — the lane's preconditions (criteria 7, 8, 9)", () => {
  it("ci.yml still gives the migration lane full history and tags", () => {
    // The policy is meaningless against a shallow, tagless checkout: every declared tag would look
    // absent. `ci.yml`'s own comment says this, and this pins it.
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/fetch-depth:\s*0/);
    expect(ci).toMatch(/migrate-from-existing/);
  });

  it("docs/RELEASING.md records the cutover constraints, each pointing at a file that resolves", () => {
    // A constraint that names a file which no longer exists has rotted into prose. Six were found by
    // three review rounds; the guard keeps each anchored to something real.
    const doc = readFileSync(join(ROOT, "docs", "RELEASING.md"), "utf8");
    const anchors = [
      ".github/workflows/pr-review-gate.yml",
      ".github/dependabot.yml",
      ".github/workflows/aios-work-sync.yml",
      "CLAUDE.md",
      "scripts/migrate-from-existing.mjs",
      "docs/CI-ARCHITECTURE.md",
    ];
    for (const a of anchors) {
      expect(doc, `RELEASING.md must cite ${a}`).toContain(a);
      expect(() => readFileSync(join(ROOT, a), "utf8"), `${a} must resolve`).not.toThrow();
    }
  });

  it("no CURRENT-STATE prose hardcodes a brain-api version — history may, and must", () => {
    // Two live false claims were found while specifying: docs/OPS.md said v1.21 and CHANGELOG.md's
    // preamble said v1.22 while lib/api/version.ts declared 1.23.
    //
    // The first spelling of this guard scanned WHOLE files and failed on `**v1.15**` inside a dated
    // CHANGELOG entry — which is correct history, not drift. A guard that forbids a changelog from
    // recording what a past release implemented is a guard that would be deleted. So it is scoped to
    // the prose that speaks in the PRESENT tense: the CHANGELOG preamble (before the first release
    // heading) and OPS's contract paragraph. Both now DEFER to the declaration instead of copying it,
    // which is the only form that cannot drift.
    const declared = readFileSync(join(ROOT, "lib", "api", "version.ts"), "utf8").match(
      /BRAIN_API_VERSION\s*=\s*"([\d.]+)"/
    )?.[1];
    expect(declared, "lib/api/version.ts must declare a version").toBeTruthy();

    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const preamble = changelog.slice(0, changelog.indexOf("## ["));
    expect(preamble).toContain("lib/api/version.ts");
    const preambleClaims = [...preamble.matchAll(/\bv(1\.\d+)\b/g)].map((m) => m[1]);
    expect(preambleClaims, "the CHANGELOG preamble must not restate a contract revision").toEqual([]);

    const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
    const para = ops.slice(ops.indexOf("The brain-api wire contract is versioned"), ops.indexOf("### Where the version is pinned"));
    expect(para).toContain("lib/api/version.ts");
    const opsClaims = [...para.matchAll(/\*\*v(1\.\d+)\*\*/g)].map((m) => m[1]);
    for (const c of opsClaims) {
      expect(c, `docs/OPS.md states brain-api v${c}; lib/api/version.ts declares ${declared}`).toBe(declared);
    }
  });

  it("install.sh states that its default is trunk, and how to install a release instead", () => {
    // The old comment said the served copy "fetches a pinned ref" — a property the file does not have:
    // it pins whatever AIOS_REF is, and the default is `main`.
    //
    // The first spelling of THIS guard asserted the phrase was absent, and then failed on the
    // correction itself, which quotes the old claim in order to explain it. Quoting a corrected claim
    // is good documentation; a guard that punishes it is teaching the wrong lesson. So the invariant
    // is the one that actually helps a reader: the file says what the default is and how to pin.
    const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect(sh).toMatch(/AIOS_REF/);
    expect(sh, "must say the default is trunk").toMatch(/default is trunk/);
    expect(sh, "must show how to install a release").toMatch(/AIOS_REF=vX\.Y\.Z/);
    expect(sh, "must point at the release process").toMatch(/docs\/RELEASING\.md/);
  });
});
