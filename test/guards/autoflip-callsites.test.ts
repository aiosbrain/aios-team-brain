import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PRET-2 (spec docs/design/pret2-convergence-gated-flip.md §2.6) — the call sites nothing else
 * pins. The auto-flip machinery is only live if the scheduler tick actually calls the pass and
 * the bootstrap actually invokes the post-seed flip; both wirings could be deleted with every
 * behavioral test still green (the pin-the-call-site rule).
 */
const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("guard: PRET-2 auto-flip call sites", () => {
  it("the ingest scheduler tick runs the pass, sequenced after the context backfill", () => {
    const src = read("lib/ingest/scheduler.ts");
    const backfillAt = src.indexOf("await runContextBackfill(db);");
    const flipAt = src.indexOf("await runAutoFlip(db);");
    expect(backfillAt, "the backfill call site must exist").toBeGreaterThan(-1);
    expect(flipAt, "the auto-flip call site must exist").toBeGreaterThan(-1);
    expect(flipAt, "the flip runs AFTER bootstrap+backfill so a team's first eligible tick can flip it").toBeGreaterThan(backfillAt);
    expect(src).toContain('await import("@/lib/admin/auto-flip-pass")');
  });

  it("the bootstrap invokes the post-seed gated flip through the named subcommand", () => {
    const src = read("docker/bootstrap.mjs");
    expect(src, "seed → drain → gated flip is the one new-team path").toMatch(/"auto-flip",\s*"demo"/);
  });

  it("the admin CLI exposes the auto-flip subcommand the bootstrap spawns", () => {
    const src = read("scripts/admin.ts");
    expect(src).toContain('case "auto-flip"');
    expect(src).toContain("autoFlipIfReady");
  });

  it("the flip write carries the guarded predicate (program §4's flip-writer contract)", () => {
    // The unit race test pins the read-back OUTCOME; this pins the PREDICATE itself — the fake
    // in that test cannot observe .eq() chains, so removing the guard would leave it green.
    const src = read("lib/admin/access-enforcement.ts");
    expect(src).toMatch(/update\(\{ access_enforcement: mode \}\)\s*\n?\s*\.eq\("id", teamId\)\s*\n?\s*\.eq\("access_enforcement", previous\)/);
  });

  it("PRET_FLIP_MAX_PER_TICK has exactly one parse site", () => {
    const pass = read("lib/admin/auto-flip-pass.ts");
    expect(pass).toContain("resolvePositiveInt(process.env.PRET_FLIP_MAX_PER_TICK, 3)");
    // No second parse anywhere else in production code — a diverging local parse is how two
    // components silently disagree about a budget (the graph-interval lesson).
    const files = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) files(p, out);
        else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
      }
      return out;
    };
    const hits = ["lib", "app", "scripts"]
      .flatMap((d) => files(join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes("process.env.PRET_FLIP_MAX_PER_TICK"))
      .map((f) => f.slice(ROOT.length + 1).split("\\").join("/"))
      .sort();
    // Comment MENTIONS elsewhere are fine; the env PARSE has exactly one owner.
    expect(hits).toEqual(["lib/admin/auto-flip-pass.ts"]);
  });
});
