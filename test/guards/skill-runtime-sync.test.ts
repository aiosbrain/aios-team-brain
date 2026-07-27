import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Skill runtime sync (playbook §2/§7). `.claude/skills/<name>/SKILL.md` is the single source
 * of truth for every agent skill here; `scripts/sync-skill-runtimes.sh` publishes each opted-in
 * skill to `.agents/skills/`, `.opencode/skills/`, and a generated `.cursor/rules/<name>.mdc`.
 *
 * Nothing stopped those copies drifting: an edit to a canonical SKILL.md that forgot
 * `bash scripts/sync-skill-runtimes.sh <name>` silently left Codex/Opencode/Cursor executing a
 * stale playbook — e.g. an old Railway boundary after the rules tightened. This guard fails the
 * build on that drift, so re-syncing is enforced rather than remembered.
 *
 * Publication is opt-in: a skill with no generated copies is intentionally Claude-only and is
 * not flagged. Once *any* copy exists, all three must exist and match.
 *
 * The drift/orphan cases run against a throwaway copy of the tree in $TMPDIR — a guard that
 * mutates the real working tree to prove itself can leave the repo dirty (or get those mutations
 * committed) if it dies mid-test.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const RUNTIME_DIRS = [".claude", ".agents", ".opencode", ".cursor"];

function check(cwd: string = ROOT) {
  const r = spawnSync("bash", ["scripts/sync-skill-runtimes.sh", "--check"], { cwd, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function prune(cwd: string) {
  spawnSync("bash", ["scripts/sync-skill-runtimes.sh", "--prune"], { cwd, encoding: "utf8" });
}

/** A disposable copy of the runtime dirs + the script, safe to mutate. */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-sync-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts", "sync-skill-runtimes.sh"), join(dir, "scripts", "sync-skill-runtimes.sh"));
  for (const d of RUNTIME_DIRS) {
    const src = join(ROOT, d);
    if (existsSync(src)) cpSync(src, join(dir, d), { recursive: true });
  }
  return dir;
}

function withSandbox(fn: (dir: string) => void) {
  const dir = sandbox();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("skill runtime sync guard", () => {
  it("every published skill is in sync across .agents / .opencode / .cursor", () => {
    const { status, out } = check();
    expect(
      status,
      "Generated skill copies drifted from .claude/skills.\n" +
        "Fix with: bash scripts/sync-skill-runtimes.sh --all   (and --prune for orphans)\n\n" +
        out
    ).toBe(0);
    expect(out).toContain("in sync");
  });

  it("the check is non-vacuous — it actually inspects published skills", () => {
    const { out } = check();
    const published = Number(/(\d+) published skills/.exec(out)?.[1] ?? 0);
    expect(published, `--check inspected no skills, so it cannot be catching drift:\n${out}`).toBeGreaterThan(0);
  });

  it("fails when a canonical SKILL.md drifts from its copies", () => {
    withSandbox((dir) => {
      const canonical = join(dir, ".claude", "skills", "railway-deploy-verify", "SKILL.md");
      writeFileSync(canonical, `${readFileSync(canonical, "utf8")}\n\nDRIFT MARKER\n`);
      const { status, out } = check(dir);
      expect(status, "a drifted canonical SKILL.md must fail --check").toBe(1);
      expect(out).toContain("STALE");
      expect(out).toContain("railway-deploy-verify");
    });
  });

  it("fails when a generated copy is hand-edited", () => {
    withSandbox((dir) => {
      const copy = join(dir, ".agents", "skills", "pr-review-attestation", "SKILL.md");
      writeFileSync(copy, `${readFileSync(copy, "utf8")}\n<!-- drift -->\n`);
      const { status, out } = check(dir);
      expect(status, "a hand-edited generated copy must fail --check").toBe(1);
      expect(out).toContain("STALE");
    });
  });

  it("fails when a Cursor rule goes stale, not just the SKILL.md copies", () => {
    withSandbox((dir) => {
      const rule = join(dir, ".cursor", "rules", "pr-review-attestation.mdc");
      writeFileSync(rule, readFileSync(rule, "utf8").replace("alwaysApply: false", "alwaysApply: true"));
      const { status, out } = check(dir);
      expect(status, "a stale generated Cursor rule must fail --check").toBe(1);
      expect(out).toContain("STALE");
      expect(out).toContain(".cursor/rules/pr-review-attestation.mdc");
    });
  });

  it("flags an orphaned copy whose .claude source is gone, and --prune clears it", () => {
    withSandbox((dir) => {
      const orphan = join(dir, ".agents", "skills", "retired-skill");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, "SKILL.md"), "---\nname: retired-skill\n---\n\nstale\n");

      const before = check(dir);
      expect(before.status, "an orphaned runtime copy must fail --check").toBe(1);
      expect(before.out).toContain("ORPHAN");

      prune(dir);
      expect(existsSync(orphan), "--prune must delete the orphaned copy").toBe(false);
      expect(check(dir).status, "--check must pass once orphans are pruned").toBe(0);
    });
  });

  it("--prune leaves hand-written Cursor rules alone", () => {
    withSandbox((dir) => {
      const handWritten = join(dir, ".cursor", "rules", "hand-written.mdc");
      mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
      writeFileSync(handWritten, "---\ndescription: 'mine'\nalwaysApply: false\n---\n\nnot generated\n");

      expect(check(dir).status, "a hand-written rule is not an orphan").toBe(0);
      prune(dir);
      expect(existsSync(handWritten), "--prune must not touch rules it did not generate").toBe(true);
    });
  });

  it("a Claude-only skill (no copies anywhere) is not flagged — publication is opt-in", () => {
    withSandbox((dir) => {
      const solo = join(dir, ".claude", "skills", "claude-only-skill");
      mkdirSync(solo, { recursive: true });
      writeFileSync(join(solo, "SKILL.md"), "---\nname: claude-only-skill\ndescription: solo\n---\n\nbody\n");
      expect(check(dir).status, "an unpublished skill must not be reported as drift").toBe(0);
    });
  });

  it("a half-published skill IS flagged", () => {
    withSandbox((dir) => {
      rmSync(join(dir, ".opencode", "skills", "pr-review-attestation"), { recursive: true, force: true });
      const { status, out } = check(dir);
      expect(status, "a skill published to some runtimes but not others must fail").toBe(1);
      expect(out).toContain("PARTIAL");
    });
  });
});

describe("generated Cursor rules", () => {
  /*
   * Cursor only parses a rule's frontmatter when the `---` block starts the file, and it expects
   * description/globs/alwaysApply — not SKILL.md's name/description. The original script prepended
   * two provenance comments ahead of the frontmatter, which made every generated rule inert: it
   * never auto-attached, and the `---` block rendered as literal body text.
   */
  const rules = [".cursor/rules/pr-review-attestation.mdc", ".cursor/rules/railway-deploy-verify.mdc"];

  it.each(rules)("%s opens with parseable Cursor frontmatter", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    expect(text.startsWith("---\n"), "frontmatter must be at byte 0").toBe(true);

    const end = text.indexOf("\n---\n", 3);
    expect(end, "frontmatter block must be closed").toBeGreaterThan(0);

    const frontmatter = text.slice(4, end);
    expect(frontmatter).toMatch(/^description: '.+'$/m);
    expect(frontmatter).toMatch(/^alwaysApply: (true|false)$/m);
    expect(frontmatter, "description must be flattened onto one line, not a folded block").not.toMatch(/^\s*>\s*$/m);

    const body = text.slice(end + 5);
    expect(body, "the source SKILL.md frontmatter leaked into the body").not.toMatch(/^name: /m);
    expect(body, "provenance marker missing — --prune relies on it").toContain("do not hand-edit");
  });
});
