import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseCandidateVerdict } from "../../scripts/release-candidate-guard.mjs";

/**
 * RELPTR-3 — the release-candidate gate.
 * Spec: `docs/design/release-pointer-cutover-guard.md` (criteria 1–16).
 *
 * WHY FOUR ASSERTIONS AND NOT THREE. Two pre-code review rounds across two models converged on this:
 * A+B+C certify "an annotated, correctly-versioned tag on SOME descendant of `main`" — which is not
 * the same claim as "the release". The attack that needs no unusual access: open a pull request and
 * never merge it, let the `pull_request`-event contexts attach to its head, tag that head. A, B and C
 * all pass, and a commit that never crossed integration is eligible to be fast-forwarded onto `main`.
 * D is the assertion that makes it the RIGHT commit, and an earlier draft of this slice CUT it.
 */

const ROOT = join(__dirname, "..", "..");
const GOOD = {
  tagName: "v0.13.0",
  tagObjectType: "tag",
  taggedTreeVersion: "0.13.0",
  mainIsAncestor: true,
  reachableFromIntegration: true,
} as const;

describe("release candidate — the four assertions (criteria 1, 2)", () => {
  it("PASSES only when all four hold", () => {
    expect(releaseCandidateVerdict(GOOD)).toEqual({ verdict: "PASS", failures: [] });
  });

  it("each assertion FAILS ALONE, with the other three holding, and names itself", () => {
    // ONE CONDITION PER FIXTURE. Each perturbation trips exactly ONE term — a fixture that trips two
    // proves only the first, and this repo has shipped that mistake. Note in particular that the
    // A-alone case uses the LIGHTWEIGHT shape, not a malformed name: a malformed name makes B's
    // expected version meaningless and would trip A and B together (criterion 15 covers names).
    const alone = [
      ["A", { ...GOOD, tagObjectType: "commit" }],
      ["B", { ...GOOD, taggedTreeVersion: "0.12.0" }],
      ["C", { ...GOOD, mainIsAncestor: false }],
      ["D", { ...GOOD, reachableFromIntegration: false }],
    ] as const;

    for (const [letter, facts] of alone) {
      const res = releaseCandidateVerdict(facts);
      expect(res.verdict, `${letter} must fail`).toBe("FAIL");
      expect(res.failures, `${letter} must fail ALONE`).toHaveLength(1);
      expect(res.failures[0], `${letter} must name itself`).toMatch(new RegExp(`^${letter}: `));
    }
  });

  it("is NON-VACUOUS about D specifically: the un-integrated candidate is the whole point", () => {
    // The concrete attack, restated as a test. Everything about this candidate is well-formed; the
    // only thing wrong with it is that it never crossed integration.
    const neverIntegrated = { ...GOOD, reachableFromIntegration: false };
    const res = releaseCandidateVerdict(neverIntegrated);
    expect(res.verdict).toBe("FAIL");
    expect(res.failures[0]).toMatch(/never crossed integration/);
    // …and dropping D from the fact set entirely must not read as "satisfied".
    expect(releaseCandidateVerdict({ ...GOOD, reachableFromIntegration: undefined }).verdict).toBe("FAIL");
  });
});

describe("release candidate — the tag itself (criteria 3, 4, 15)", () => {
  it("FAILS a LIGHTWEIGHT tag, naming annotation as the reason", () => {
    // The corpus is genuinely mixed: `v0.12.0` is a `tag` object and `v0.10.0` is a `commit`, so this
    // is a real tightening rather than a restatement of what git already guarantees.
    const res = releaseCandidateVerdict({ ...GOOD, tagObjectType: "commit" });
    expect(res.verdict).toBe("FAIL");
    expect(res.failures[0]).toMatch(/LIGHTWEIGHT/);
    expect(res.failures[0]).toMatch(/annotated/);
    // …and the annotated shape passes, so the assertion discriminates rather than always failing.
    expect(releaseCandidateVerdict({ ...GOOD, tagObjectType: "tag" }).verdict).toBe("PASS");
  });

  it("FAILS a version mismatch in EITHER direction", () => {
    // A one-directional check (say, only "tree is older than the tag") passes half the half-cut
    // releases it exists for. Both directions, explicitly.
    const tagAhead = releaseCandidateVerdict({ ...GOOD, taggedTreeVersion: "0.12.0" });
    const treeAhead = releaseCandidateVerdict({ ...GOOD, taggedTreeVersion: "0.14.0" });
    for (const res of [tagAhead, treeAhead]) {
      expect(res.verdict).toBe("FAIL");
      expect(res.failures[0]).toMatch(/^B: /);
    }
    // An absent version is a mismatch, not a pass — `package.json` unreadable at the tagged tree.
    expect(releaseCandidateVerdict({ ...GOOD, taggedTreeVersion: null }).verdict).toBe("FAIL");
  });

  it("REJECTS a name that is not exactly vX.Y.Z — loudly, not silently (criterion 15)", () => {
    // WHY FAIL AND NOT SKIP, stated precisely because an earlier draft got the reason wrong: a
    // skipped tag mints NO context, which is already safe — the commit simply cannot be
    // fast-forwarded. FAIL is chosen for LOUDNESS, not for safety. The sanctioned escape hatch for
    // anything that is not a release is a NON-`v` prefix (`rc/`, `cutover/`), which never triggers
    // the workflow at all.
    for (const bad of ["v0.13.0-rc.1", "v0.13.0+build.1", "0.13.0", "v1.2", "v01.2.3"]) {
      // The tree version is set to agree with the stripped name so ONLY the name term can trip.
      const res = releaseCandidateVerdict({ ...GOOD, tagName: bad, taggedTreeVersion: bad.replace(/^v/, "") });
      expect(res.verdict, `${bad} must fail`).toBe("FAIL");
      expect(res.failures.filter((f) => f.startsWith("A: ")), `${bad} trips A alone`).toHaveLength(1);
      expect(res.failures[0]).toMatch(/not exactly vX\.Y\.Z/);
    }
  });

  it("documents the non-`v` escape hatch in the failure text, so nobody relaxes the regex", () => {
    const res = releaseCandidateVerdict({ ...GOOD, tagName: "v0.13.0-rc.1", taggedTreeVersion: "0.13.0-rc.1" });
    expect(res.failures[0]).toMatch(/rc\/|cutover\//);
  });
});

describe("release candidate — the workflow that runs it (criteria 6, 7, 8)", () => {
  const WF = readFileSync(join(ROOT, ".github/workflows/release-candidate.yml"), "utf8");

  it("triggers on a TAG push and on nothing else", () => {
    // Decision 4's no-red-box property, checked rather than asserted. If this ever gains a
    // `pull_request` or branch trigger it becomes able to redden ordinary work, and the reason the
    // slice was safe to land early evaporates.
    expect(WF).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*-\s*"v\*"/);
    expect(WF, "must not trigger on pull_request").not.toMatch(/^\s*pull_request(_target)?:/m);
    expect(WF, "must not trigger on a branch push").not.toMatch(/^\s*branches:/m);
  });

  it("asks for full history, since ancestry and reachability need it", () => {
    expect(WF).toMatch(/fetch-depth:\s*0/);
  });

  it("carries NO ref-scoping `if:` that could exclude the tag event", () => {
    // A job-level `if: github.ref == ...` would let the trigger guards above stay green while the
    // gate silently stopped running for the event it exists for.
    expect(WF).not.toMatch(/^\s*if:/m);
  });

  it("ACTUALLY INVOKES the guard, and nothing neutralises its exit status (criterion 8)", () => {
    // Without this, a workflow running `echo ok` satisfies every trigger assertion above while the
    // carefully tested entry point is never called — the "pin the call site, not just the function"
    // lesson, applied one layer up.
    expect(WF).toMatch(/node scripts\/release-candidate-guard\.mjs --run/);
    expect(WF, "no continue-on-error").not.toMatch(/continue-on-error/);
    expect(WF, "no `|| true`").not.toMatch(/\|\|\s*true/);
  });

  it("declares read-only contents, like every other workflow here", () => {
    expect(WF).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });
});

describe("release candidate — the entry path is wired (criteria 5, 12, 16)", () => {
  const SRC = readFileSync(join(ROOT, "scripts/release-candidate-guard.mjs"), "utf8");

  it("binds the validated commit to the IMMUTABLE event SHA, and fails closed", () => {
    // The wrong-green path that made round 1 DECLINE and round 2 BLOCK: resolving the tag at job time
    // is a race, because the tag can be force-moved after the push. The green would attach to the
    // ORIGINAL commit while the job validated a different one.
    expect(SRC).toMatch(/peeled\s*!==\s*String\(sha\)/);
    expect(SRC).toMatch(/throw new Error\(\s*\n?\s*`refusing:/);
  });

  it("re-fetches the tag object rather than trusting checkout's leftovers (criterion 12)", () => {
    // `actions/checkout` re-fetches the triggering tag as `+<commit>:refs/tags/<tag>`, turning an
    // annotated tag lightweight LOCALLY. Reading the object type from that would fail assertion A on
    // every valid release — a red check with an entirely fictional cause.
    expect(SRC).toMatch(/git\("fetch", "--force", remote, `\+refs\/tags\/\$\{name\}:refs\/tags\/\$\{name\}`\)/);
    // …and the type must be read AFTER that fetch, not before.
    expect(SRC.indexOf('git("fetch"')).toBeLessThan(SRC.indexOf('cat-file'));
  });

  it("routes through releaseCandidateVerdict and exits NON-ZERO on FAIL (criterion 16)", () => {
    // Tests over a pure function say nothing about whether anything calls it. Pin the call site.
    expect(SRC).toMatch(/releaseCandidateVerdict\(facts\)/);
    expect(SRC).toMatch(/process\.exit\(verdict === "PASS" \? 0 : 1\)/);
  });

  it("runs ONLY on a positive ack token, so importing it is silent", () => {
    // Not a `process.argv[1]` vs `import.meta.url` comparison: this repo shipped that once and it
    // printed nothing and exited 0 from a symlinked path, which a shell reads as a green light.
    expect(SRC).toMatch(/process\.argv\.includes\("--run"\)/);
    expect(SRC).not.toMatch(/import\.meta\.url\s*===/);
  });

  it("refuses any ref that is not a tag", () => {
    expect(SRC).toMatch(/runs on tag pushes only/);
  });
});
