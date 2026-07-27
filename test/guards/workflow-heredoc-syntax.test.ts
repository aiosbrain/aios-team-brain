import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * BUILD-FAILING GUARD: every `node <<'NODE'` heredoc in a workflow is at least SYNTACTICALLY valid.
 *
 * These heredocs are real programs that no test tier can reach — they only ever run on GitHub's runners,
 * on a PR event, often on the merge path. A typo in one is invisible locally and shows up as a workflow
 * that either warns nothing or fails to close a task, both of which look like "fine" from here.
 *
 * The class is real: today's work rewrote two of these by hand. This does not prove the logic (the logic
 * belongs in `scripts/`, which is the point of `pr-work-keys.mjs`) — it proves the file parses, which is
 * the failure that costs a round-trip through CI to discover.
 */

const WORKFLOWS = join(process.cwd(), ".github", "workflows");

/** Every `node <<'NODE' … NODE` block in a workflow, de-indented back to real source. */
function heredocs(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)node\s+<<'(\w+)'\s*$/);
    if (!open) continue;
    const [, indent, marker] = open;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === marker) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    }
    out.push(body.join("\n"));
  }
  return out;
}

describe("guard: workflow node heredocs parse", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  // Numbered PER FILE, so a failure names the block you have to go and look at.
  const blocks = files.flatMap((f) => heredocs(readFileSync(join(WORKFLOWS, f), "utf8")).map((src, n) => ({ f, src, n: n + 1 })));

  it("finds the heredocs (or this guard is vacuous)", () => {
    expect(blocks.length, "no `node <<'NODE'` blocks found — has the pattern changed?").toBeGreaterThan(0);
  });

  it.each(blocks.map((b) => [`${b.f} heredoc #${b.n}`, b.src]))("%s is valid JavaScript", (_label, src) => {
    const file = join(mkdtempSync(join(tmpdir(), "wf-heredoc-")), "block.js");
    writeFileSync(file, src as string);
    // `node --check` parses without executing — no network, no side effects.
    expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).not.toThrow();
  });
});
