import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isOperativeLine, scanInventory, trackedInventory, report } from "../../scripts/instruction-base.mjs";
import { CONTRIBUTION_BASE, INTEGRATION_BRANCH, RELEASE_BRANCH } from "../../scripts/branches.mjs";

// Assertions derive from RELPTR-5 criteria 1–16 and its named disposition, not scan output.
const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const skill = (name: string) => `.claude/skills/${name}/SKILL.md`;
const att = skill("pr-review-attestation");
const rubric = ".claude/skills/pr-review-attestation/evals/rubric.md";
const evals = ".claude/skills/pr-review-attestation/evals/evals.json";
const resolution = 'root="$(git rev-parse --show-toplevel)"\nbase="$(node "$root/scripts/branches.mjs" --print contribution)"';
const fetch = 'git -C "$root" fetch origin "$base"';
const diff = 'git -C "$root" diff "origin/$base...HEAD"';
const sequence = `${resolution}\n${fetch}\n${diff}`;
const prose = 'the contribution base (currently `staging`, declared in `scripts/branches.mjs`)';
const normalized = (path: string) => read(path).replace(/^ +/gm, "");

// Each entry is a SITE, including scan-blind grading/prose. Deleting any site must fail.
const sites: [string, string][] = [
  [att, `Get the diff — against a fresh remote ref for ${prose}`],
  [att, sequence],
  [att, 'remote contribution-base ref is a few hours stale'],
  [rubric, '**The diff is fresh.**'],
  [rubric, '`base="$(node "$root/scripts/branches.mjs" --print contribution)"`;'],
  [rubric, fetch],
  [rubric, diff],
  [rubric, 'The diff is taken against the resolved remote contribution-base ref with no preceding fetch'],
  [skill("branch-reconciliation"), `${resolution}\n git -C "$root" fetch --prune origin`.replace("\n git", "\ngit")],
  [skill("branch-reconciliation"), 'git -C "$root" branch -r --no-merged "origin/$base"'],
  [skill("branch-reconciliation"), 'git -C "$root" cherry "origin/$base" origin/<branch>'],
  [skill("branch-reconciliation"), 'git -C "$root" diff "origin/$base...origin/<branch>" --name-only'],
  [skill("branch-reconciliation"), 'git -C "$root" diff "origin/$base:<file>" origin/<branch>:<file>'],
  [skill("branch-reconciliation"), 'git -C "$root" log "origin/$base" --grep="<commit subject>"'],
  [skill("branch-reconciliation"), 'patch-equivalent to something already on the contribution base'],
  [skill("branch-reconciliation"), 'matching contribution-base commit(s) as evidence'],
  [skill("branch-reconciliation"), 'compare current contribution-base content directly'],
  [skill("branch-reconciliation"), 'current contribution base, and a merged PR'],
  [skill("branch-reconciliation"), 'merge risk against the current contribution base'],
  [skill("test-ci-wiring-audit"), resolution],
  [skill("test-ci-wiring-audit"), 'git -C "$root" log -1 --format=%ci "origin/$base"'],
  [skill("test-ci-wiring-audit"), "latest contribution-base commit"],
  [skill("adversarial-build"), `Branch from ${prose}`],
  [skill("adversarial-build"), `retarget to ${prose} after it merges`],
  [skill("adversarial-build"), `gh pr create\` — base: ${prose}`],
  [".claude/agents/code-reviewer.md", sequence],
  ["CLAUDE.md", sequence],
  ["CONTRIBUTING.md", `${resolution}\n${fetch}`],
  ["CONTRIBUTING.md", 'cd "$root/../aios-team-brain-<short-task>"'],
  ["CONTRIBUTING.md", 'git -C "$root" worktree add -b feat/<short-task> ../aios-team-brain-<short-task> "origin/$base"'],
  ["docs/TODO.md", resolution],
  ["docs/TODO.md", 'git -C "$root" log --oneline -20 "origin/$base"'],
  ["docs/TODO.md", fetch],
  ["docs/TODO.md", `Also \`${fetch}\` partway through a long build`],
  ["docs/TODO.md", "diff the closed branch vs the contribution base"],
  [skill("branch-reconciliation"), `Use ${prose}.`],
  ["docs/RELEASING.md", sequence],
  ["scripts/pr-review-gate.mjs", 'from "./branches.mjs"'],
];

describe("primary per-site disposition (6–9, 13–14)", () => {
  it.each(sites)("%s retains site %s", (path, expected) => {
    expect(normalized(path)).toContain(expected);
  });
  const canonical = [...new Set([...sites.map(([path]) => path), evals])];
  it("covers exactly twelve canonical files", () => expect(canonical).toHaveLength(12));
  it.each(canonical)("%s has no residual hardcoded instruction", (path) => {
    const text = path === "docs/RELEASING.md"
      ? read(path).split("\n").filter(line => ![
          "`origin/main` or `origin/staging` together with `/\\bgit\\s+[a-z-]+\\b/` on the same line,",
          'PR-base prose, and "Branch from `origin/main`", which carries no `git` token. Both success and',
        ].includes(line)).join("\n") : read(path);
    expect(text).not.toMatch(/origin\/(main|staging)\b/);
    expect(text).not.toMatch(/fetch origin (main|staging)\b/);
  });
  it("eval prompt and fetch requirement grade the resolved base (7–8)", () => {
    const first = JSON.parse(read(evals)).evals.find((e: { id: number }) => e.id === 1);
    expect(first.prompt).toContain(sequence);
    expect(first.assertions).toContain(`Runs \`${fetch}\` before diffing, using the same resolved contribution base, so the diff can't carry other people's merged commits`);
  });
  it("runbook retains the hazard, preparation, human work and corrected inventory (13)", () => {
    const text = read("docs/RELEASING.md");
    const row = text.split("\n").find(l => l.startsWith("| 4 |"))!;
    for (const phrase of ["PREPARED (RELPTR-5)", "every unreleased commit", "same resolved contribution base", "Still human at cutover"]) expect(row).toContain(phrase);
    const sections = text.slice(text.indexOf("### 3.1c"), text.indexOf("### 3.2"));
    expect(sections).not.toMatch(/31 (?:operative .*?command )?lines across 19 files/);
    expect(sections).toContain("12 canonical files");
    expect(sections).toContain("22 path-form occurrences + 4 refspec occurrences");
    expect(sections).toContain("per-site presence AND absence");
    expect(sections).toContain("trusted-automation");
    expect(sections).toContain("Do the policy **first**");
  });
});

describe("deliberately partial scan (1–5, 10, 12, 16)", () => {
  it.each([
    ["git branch -r --no-merged origin/main", true],
    ["git diff origin/staging...HEAD", true],
    ["git diff origin/topic...HEAD", false],
    ['`origin/main` kept that state loud', false],
    ['"Branch from `origin/main`", which carries no `git` token.', false],
    ['git(dir, "update-ref", "refs/remotes/origin/main", parent)', false],
    ["git fetch origin main", false],
    ["open a PR against main", false],
    ["Branch from origin/staging", false],
    ["git  diff origin/main", true],
    ["git origin/main", true],
    ["git DIFF origin/main", false],
    ["git diff origin/mainland", false],
    ["git\tdiff origin/staging", true],
  ])("classifies %s as %s", (line, expected) => expect(isOperativeLine(line)).toBe(expected));
  it("scans injected paths regardless of root or extension and respects history", () => {
    const records = ["odd/place.bin", "rootfile", ".cursor/rules/new.mdc", "docs/archive/old.md", "docs/design/old.md", "test/guards/instruction-base.test.ts"]
      .map(path => ({ path, content: "intro\ngit diff origin/main...HEAD\n" }));
    expect(scanInventory(records)).toEqual(records.slice(0, 3).map(({ path }) => ({ path, line: 2, text: "git diff origin/main...HEAD" })));
  });
  it("inventory equals an independent git ls-files minus independently specified exclusions, also from nested cwd", () => {
    const expected = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean)
      .filter(p => !["docs/design/", "docs/archive/", ".context/"].some(prefix => p.startsWith(prefix)))
      .filter(p => !["test/guards/branch-roles.test.ts", "test/guards/instruction-base.test.ts", "scripts/instruction-base.mjs"].includes(p));
    for (const cwd of [ROOT, join(ROOT, ".claude/skills")]) {
      expect(new Set(trackedInventory(cwd).map((r: { path: string }) => r.path))).toEqual(new Set(expected));
    }
  });
  it("has no operative path-form regression (mirrors must be generated)", () => expect(scanInventory(trackedInventory(ROOT))).toEqual([]));
  it.each([{ hits: [] }, { hits: [{ path: "x", line: 1, text: "git diff origin/main" }] }])("both report outcomes state blind spots", ({ hits }) => {
    const message = report(hits);
    for (const phrase of ["PARTIAL", "refspec", "PR-base prose", "bare", "per-site"]) expect(message).toContain(phrase);
  });
  it("archives handoff prompts (12)", () => {
    expect(existsSync(join(ROOT, "docs/agent-handoffs.md"))).toBe(false);
    expect(read("docs/archive/agent-handoffs.md")).toMatch(/archiv/i);
    expect(scanInventory([{ path: "docs/archive/agent-handoffs.md", content: "git diff origin/main" }])).toEqual([]);
  });
});

// Pure local fixtures: no network, secrets, hooks, signing, index, or checkout mutations.
const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) as NodeJS.ProcessEnv;
Object.assign(isolated, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: isolated, encoding: "utf8" }).trim();
function scratch(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "instruction base 'fixture-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function advance(cwd: string, branch: string, name: string, parent?: string) {
  // fast-import creates a real commit and advances the fixture ref without add/commit/update-ref.
  const input = `commit refs/heads/${branch}\ncommitter Test <test@example.invalid> 1000000000 +0000\ndata ${name.length}\n${name}\n${parent ? `from ${parent}\n` : ""}M 100644 inline ${name}.txt\ndata ${name.length}\n${name}\n\ndone\n`;
  execFileSync("git", ["fast-import", "--quiet"], { cwd, env: isolated, input, stdio: ["pipe", "pipe", "pipe"] });
  return git(cwd, "rev-parse", `refs/heads/${branch}`);
}
describe("observable shell and role identity (11, 15)", () => {
  it.each(["main", "staging"])("executes the sanctioned sequence with fresh %s from nested cwd", base => scratch(dir => {
    const remote = join(dir, "path remote");
    const work = join(dir, "working copy");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q", `--initial-branch=${base}`);
    const old = advance(remote, base, "initial");
    git(dir, "clone", "-q", remote, work);
    mkdirSync(join(work, "scripts"));
    writeFileSync(join(work, "scripts/branches.mjs"), `if (process.argv.slice(2).join(" ") !== "--print contribution") throw Error("wrong role"); process.stdout.write(${JSON.stringify(base)});`);
    const head = advance(work, "feature", "feature", old);
    git(work, "symbolic-ref", "HEAD", "refs/heads/feature");
    const fresh = advance(remote, base, "advanced", old);
    expect(git(work, "rev-parse", `origin/${base}`)).toBe(old);
    expect(old).not.toBe(fresh);
    const nested = join(work, "nested/deeper");
    mkdirSync(nested, { recursive: true });
    // Execute the actual documented block, also pinned independently to Decision 2 above.
    const documented = normalized(att).match(/```bash\n([\s\S]*?)\n```/)![1];
    expect(documented).toBe(sequence);
    const output = execFileSync("bash", ["-eu", "-c", documented], { cwd: nested, env: isolated, encoding: "utf8" });
    expect(git(work, "rev-parse", `origin/${base}`)).toBe(fresh);
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(output).toContain("+feature");
    expect(output).not.toContain("+advanced");
  }));
  /**
   * RELPTR-6 D3 — THE SENTINEL MUST BE A VALUE NO ROLE HOLDS, and this test used to violate that.
   *
   * It stubbed `CONTRIBUTION_BASE = "staging"` and asserted the rendered message says
   * `origin/staging...HEAD`. That discriminates ONLY because `staging` is not the real contribution
   * base: if `pr-review-gate.mjs` hardcoded the branch instead of importing the role, the output
   * would say `origin/main` and the assertions would redden. The cutover makes `staging` the REAL
   * value — at which point a hardcoded `origin/staging` renders exactly what a correct
   * implementation renders, all three assertions still pass, and the test proves nothing. Nothing
   * reddens to announce the loss, which makes this the silent member of the D1/D2/D3 set.
   *
   * The fix is a sentinel drawn from no role's value-space, checked against every role rather than
   * against a remembered one, plus an executed negative control below — because a stub that cannot
   * fail is the same failure in a new spelling.
   */
  const BASE_SENTINEL = "contribution-sentinel";
  const RELEASE_SENTINEL = "release-sentinel";
  const stubbedRoles = `export const CONTRIBUTION_BASE = ${JSON.stringify(BASE_SENTINEL)}; export const RELEASE_BRANCH = ${JSON.stringify(RELEASE_SENTINEL)};`;
  const renderMissing = (dir: string) =>
    execFileSync("node", ["--input-type=module", "-e", `import { FAIL_MESSAGE } from ${JSON.stringify(pathToFileURL(join(dir, "pr-review-gate.mjs")).href)}; console.log(FAIL_MESSAGE.missing);`], { env: isolated, encoding: "utf8" });

  it("the sentinels are values NO branch role holds, now and after the cutover", () => {
    // Asserted, not asserted-about-in-a-comment: this is the property the whole fixture rests on,
    // and the only thing standing between it and the vacuity it just came out of.
    for (const role of [CONTRIBUTION_BASE, INTEGRATION_BRANCH, RELEASE_BRANCH]) {
      expect(BASE_SENTINEL, "a sentinel equal to a real role cannot discriminate").not.toBe(role);
      expect(RELEASE_SENTINEL).not.toBe(role);
    }
  });

  it("runtime gate follows contribution, independently of release", () => scratch(dir => {
    writeFileSync(join(dir, "branches.mjs"), stubbedRoles);
    writeFileSync(join(dir, "pr-review-gate.mjs"), read("scripts/pr-review-gate.mjs"));
    const output = renderMissing(dir);
    expect(output).toContain(`origin/${BASE_SENTINEL}...HEAD`);
    // Every REAL role name must be absent — not just `main`. A gate hardcoding the post-cutover
    // value is the regression this now catches and previously would not have.
    for (const role of [CONTRIBUTION_BASE, INTEGRATION_BRANCH, RELEASE_BRANCH]) expect(output).not.toContain(`origin/${role}`);
    expect(output).not.toContain(RELEASE_SENTINEL);
  }));

  it("is NON-VACUOUS: a gate that hardcodes the base instead of importing the role FAILS", () => scratch(dir => {
    // The negative control, executed. Without it the assertions above are a claim about a mutation
    // nobody ran — and D3 is precisely the case where the assertions kept passing against a broken
    // implementation. Mutating to the literal `main` proves the same thing pre- and post-cutover.
    writeFileSync(join(dir, "branches.mjs"), stubbedRoles);
    const src = read("scripts/pr-review-gate.mjs");
    const hardcoded = src.replace("origin/${CONTRIBUTION_BASE}...HEAD", "origin/main...HEAD");
    expect(hardcoded, "the mutation must apply").not.toBe(src);
    writeFileSync(join(dir, "pr-review-gate.mjs"), hardcoded);
    const output = renderMissing(dir);
    expect(output, "the mutant renders a hardcoded ref").toContain("origin/main...HEAD");
    expect(output, "…and NOT the resolved role, which is what the test above pins").not.toContain(`origin/${BASE_SENTINEL}...HEAD`);
  }));
  it("fails loudly when a tracked file cannot be read", () => scratch(dir => {
    git(dir, "init", "-q");
    advance(dir, "main", "missing");
    // Populate the fixture index without checking files out; tracked missing content must throw.
    git(dir, "read-tree", "refs/heads/main");
    expect(() => trackedInventory(dir)).toThrow(/missing\.txt/);
  }));
});
