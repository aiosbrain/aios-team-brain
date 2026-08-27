import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { main as runGate, releaseCandidateVerdict } from "../../scripts/release-candidate-guard.mjs";

/**
 * RELPTR-3 — the release-candidate gate.
 * Spec: `docs/design/release-pointer-cutover-guard.md` (criteria 1–17).
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

  it("triggers on a TAG push and on NOTHING else — the whole `on:` block, compared exactly", () => {
    // Decision 4's no-red-box property. The first version of this test listed forbidden spellings,
    // and both reviewers walked past it: `branches-ignore: [never]` under `push:` opts BRANCH pushes
    // back in (GitHub treats branch and tag filters independently), so every push to `main` would run
    // the gate and go red at `resolveEventTag` — while every assertion here stayed green. `schedule:`
    // and `workflow_call:` slipped through the same way.
    //
    // An enumeration of what is forbidden can only ever be as complete as the author's imagination.
    // Comparing the PARSED trigger to the one shape that is allowed inverts that: anything added,
    // anywhere in the block, reddens without this test having to have predicted it.
    // The `on:` key must EXIST and be exactly this. Asserting existence separately matters: an
    // earlier version fell back to `doc[String(true)]` as "YAML 1.1 compatibility hardening", and
    // Codex showed the hardening was itself a hole — a document whose only key is a literal `true:`
    // (no `on:` at all, i.e. a workflow GitHub would never run) satisfied the fallback and the
    // comparison passed. The pinned `yaml` is 1.2, where `on` is a plain string key, so there is
    // nothing to be compatible with; guessing at a second spelling only widened what counts as a pass.
    const doc = parseYaml(WF) as Record<string, unknown>;
    expect(Object.keys(doc), "the trigger must be spelled `on:`").toContain("on");
    expect(doc["on"]).toEqual({ push: { tags: ["v*"] } });
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

/**
 * THE WIRING, against real git — not the pure decision, the code that COMPUTES its inputs.
 *
 * Why this exists at all: `releaseCandidateVerdict` takes `reachableFromIntegration` as a boolean, so
 * every test above passes whatever it likes and none of them pins the `merge-base` argument order that
 * produces it. Swap the arguments and, in today's pre-cutover graph, the answer flips to `true` —
 * `staging` is BEHIND `main`, so `staging` is an ancestor of any candidate. A silent inversion of the
 * one assertion two review rounds existed to restore, passing green. Found by probing git directly,
 * after both reviewers had verified the order was correct without noting that nothing held it there.
 */
describe("release candidate — the wiring, against real git (criteria 5, 12, 16)", () => {
  // A developer's or CI runner's git config must not reach these repos. Both reviewers flagged that
  // the first version isolated only the SETUP calls, while the calls inside `runGate` inherited the
  // real global AND system config — `commit.gpgSign`, `core.hooksPath`, a url rewrite, or an inherited
  // `GIT_DIR` could break them or point them somewhere else entirely. Neither found a vacuous-pass
  // route, but "fails for an unrelated reason" is its own cost. Isolated once, for every child process.
  const ISOLATED = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  beforeAll(() => {
    for (const [k, v] of Object.entries(ISOLATED)) vi.stubEnv(k, v);
    // UNSET, not blanked: git treats a set-but-empty GIT_DIR as a path and dies with
    // "fatal: The empty string is not a valid path". An inherited one would override every `cwd`.
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) vi.stubEnv(k, undefined);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Every scratch repo made in this block, removed in `afterAll` — five leaked before. */
  const made: string[] = [];

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** A repo with `main` ahead of `integration`, and an annotated tag on main's tip. */
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "rcg-"));
    made.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    git(dir, "branch", "integration");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "release prep");
    git(dir, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
    return { dir, head: git(dir, "rev-parse", "HEAD") };
  }

  const run = (dir: string, head: string) =>
    runGate({
      ref: "refs/tags/v0.2.0",
      sha: head,
      remote: ".",
      mainRef: "refs/heads/main",
      integrationRef: "refs/heads/integration",
      cwd: dir,
      log: () => {},
    });

  it("computes D in the RIGHT DIRECTION: un-integrated candidate FAILS", () => {
    const { dir, head } = scratch();
    const res = run(dir, head);
    // `integration` is behind, exactly like `staging` is today. The candidate did not cross it.
    expect(res.facts.reachableFromIntegration, "candidate is NOT reachable from integration").toBe(false);
    // …and the inverted question would have answered `true`, which is what makes this test necessary.
    expect(
      (() => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", "refs/heads/integration", head], { cwd: dir, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })(),
      "the INVERTED order would have said true — a silent pass"
    ).toBe(true);
    expect(res.verdict).toBe("FAIL");
    expect(res.failures.join(" ")).toMatch(/never crossed integration/);
  });

  it("PASSES once the candidate really is on the integration line", () => {
    const { dir, head } = scratch();
    git(dir, "branch", "-f", "integration", head); // the cutover's fast-forward, in miniature
    const res = run(dir, head);
    expect(res.facts).toMatchObject({
      tagName: "v0.2.0",
      tagObjectType: "tag",
      taggedTreeVersion: "0.2.0",
      mainIsAncestor: true,
      reachableFromIntegration: true,
    });
    expect(res.verdict).toBe("PASS");
  });

  it("reads the object type as ANNOTATED for an annotated tag, and lightweight for a lightweight one", () => {
    const { dir, head } = scratch();
    git(dir, "branch", "-f", "integration", head);
    expect(run(dir, head).facts.tagObjectType).toBe("tag");
    // Replace it with a lightweight tag at the same commit: A must now fail.
    git(dir, "tag", "-d", "v0.2.0");
    git(dir, "tag", "v0.2.0", head);
    const res = run(dir, head);
    expect(res.facts.tagObjectType).toBe("commit");
    expect(res.verdict).toBe("FAIL");
    expect(res.failures.join(" ")).toMatch(/LIGHTWEIGHT/);
  });

  it("FAILS CLOSED when the tag has moved away from the event's SHA", () => {
    const { dir, head } = scratch();
    git(dir, "branch", "-f", "integration", head);
    const stale = git(dir, "rev-parse", "HEAD~1");
    // The event said `head`; the ref now peels somewhere else. Validating it would attach a green to
    // a commit this run never examined.
    expect(() => run(dir, stale)).toThrow(/refusing:/);
  });

  it("REFUSES a ref that is not a tag", () => {
    const { dir, head } = scratch();
    expect(() => runGate({ ref: "refs/heads/main", sha: head, remote: ".", cwd: dir, log: () => {} })).toThrow(
      /tag pushes only/
    );
  });
});
