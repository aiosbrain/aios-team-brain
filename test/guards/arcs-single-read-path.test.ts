import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PRET-3 / program AC2 (docs/design/retire-permissive-model.md §7.2,
 * docs/design/pret3-arcs-unification.md §4.3): the fused panel is the ONLY arcs read, and every
 * reader class resolves through the ONE mode-keyed `resolveArcScope`. The retirement is
 * STRUCTURAL (getArcs/recomputeArcs require a `g:` scopeKey — tsc refuses a tier-path caller),
 * so this guard pins what types cannot: the call sites, and the absence of the retired arms.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("guard: the arcs single read path (PRET-3)", () => {
  it("all three consumers resolve through resolveArcScope", () => {
    expect(read("app/api/brain/arcs/route.ts")).toContain("resolveArcScope(admin,");
    expect(read("app/api/brain/arcs/recompute/route.ts")).toContain("resolveArcScope(admin,");
    expect(read("app/t/[team]/social/actions.ts")).toContain("resolveArcScope(db,");
  });

  it("no arcs surface builds a tier union — visibleGroupIds is gone from all three", () => {
    for (const f of ["app/api/brain/arcs/route.ts", "app/api/brain/arcs/recompute/route.ts", "app/t/[team]/social/actions.ts"]) {
      expect(read(f), `${f} must not resurrect the tier union`).not.toContain("visibleGroupIds(");
    }
  });

  it("the corrections legacy arm is dead in production", () => {
    // The one production `true` caller was getArcs' tier entry; the H2 migration re-keyed the
    // rows it served. `includeLegacy: true` surviving anywhere in lib/app is the arm reopening.
    const files = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) files(p, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(p);
      }
      return out;
    };
    const hits = ["lib", "app"]
      .flatMap((d) => files(join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes("includeLegacy: true"))
      .map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual([]);
  });

  it("discover-arcs' fallback is the fused read, not a tier synthesis", () => {
    const src = read("lib/social/discover-arcs.ts");
    expect(src).toContain("getFusedArcs(db, teamId, teamSlug, groups, keys)");
    expect(src).not.toContain("getArcs(");
  });
});
