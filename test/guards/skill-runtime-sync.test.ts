import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A published skill's .agents/.opencode/.cursor copies must stay byte-identical to its
 * .claude/skills/<name>/SKILL.md source (scripts/sync-skill-runtimes.sh). An edit to the
 * canonical SKILL.md that forgets to re-run the sync leaves Codex/Opencode/Cursor on a stale
 * playbook silently — this guard fails the build instead.
 */

const SCRIPT = "scripts/sync-skill-runtimes.sh";

function check() {
  return spawnSync("bash", [SCRIPT, "--check"], { cwd: process.cwd(), encoding: "utf8" });
}

describe("skill runtime sync guard", () => {
  it("passes for the committed skill tree", () => {
    const result = check();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("in sync");
  });

  describe("fails non-vacuously when a copy drifts", () => {
    const target = ".agents/skills/pr-review-attestation/SKILL.md";
    let original: string;

    afterEach(() => {
      writeFileSync(target, original);
    });

    it("detects a hand-edited generated copy", () => {
      original = readFileSync(target, "utf8");
      writeFileSync(target, `${original}\n<!-- drift -->\n`);
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("pr-review-attestation");
    });
  });

  it("detects an orphaned generated copy with no .claude source", () => {
    const orphanDir = ".agents/skills/__guard_test_orphan__";
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "SKILL.md"), "---\nname: __guard_test_orphan__\n---\nx\n");
    try {
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ORPHAN");
    } finally {
      rmSync(orphanDir, { recursive: true, force: true });
    }
  });
});
