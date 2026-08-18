import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * VIB-341 — the reader and the writer must agree on a graph group id BY CONSTRUCTION.
 *
 * `projects.graph_group_id` is immutable for the §11 built-ins, so after a team slug rename the
 * pointer is a FROZEN id under the OLD slug. Anything that spells a group id from the LIVE slug
 * therefore names a different group than the projector writes to — and it fails SILENTLY: no
 * error, no empty-graph banner, just a surface that is permanently empty while every diagnostic
 * reads healthy. That cost a day on 2026-08-18.
 *
 * The tier-visible READ set is now resolved from the pointers by `lib/graph/tier-groups.ts`, and
 * `visibleGroupIds` is DELETED — so tsc already refuses the most likely mistake. `episodeGroupId`
 * has to survive (it is the MINT: what a pointer is minted from, and the projector's documented
 * quiet fallback for an unbootstrapped team), and it is the remaining way to re-derive from a slug
 * by hand. This guard pins WHO may call it.
 *
 * Adding a file here is a deliberate act: to justify it, say why that call site cannot disagree
 * with the pointer — not merely that it happens to be correct today.
 */
const ROOT = join(import.meta.dirname, "..", "..");

/** Files allowed to spell a tier group id from a slug, and the reason each is not a read leg. */
const ALLOWED: Record<string, string> = {
  "lib/graph/group.ts": "defines the mint",
  "lib/graph/project-pointer.ts": "MINTS the pointer — this is the one place a slug becomes a stored id",
  "lib/graph/project.ts": "the WRITER's unbootstrapped fallback; tier-groups.ts mirrors it so both sides agree",
  "lib/graph/tier-groups.ts": "the pointer-resolving read authority; same unbootstrapped fallback as the writer",
  "lib/cache/tier-invalidation.ts": "cache PURGE keys — pointer-first, slug only as a widen-on-error fallback",
};

/** Source with comments stripped — these files DOCUMENT the deleted symbol and the slug-derivation
 *  trap at length, and a guard that trips on its own explanation teaches people to delete the
 *  explanation. Match CODE only. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("guard: nothing re-derives a graph group id from the live team slug (VIB-341)", () => {
  it("only the mint, the writer, and the pointer-resolving reader call episodeGroupId", () => {
    const callers = ["lib", "app", "components"]
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /\bepisodeGroupId\(/.test(code(f)))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect(callers).toEqual(Object.keys(ALLOWED).sort());
  });

  it("visibleGroupIds is gone — no module exports or imports it", () => {
    // Deleted rather than deprecated: a symbol that still exists is a symbol a future read leg
    // imports. With it gone the compiler enforces this, and the check below just keeps the
    // deletion from being quietly undone.
    const hits = ["lib", "app", "components"]
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /\bvisibleGroupIds\b/.test(code(f)))
      .map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual([]);
  });

  // WHAT THIS PROVES, EXACTLY: that each leg still REFERENCES the pointer authority. It is a
  // text-presence check, so it cannot prove the resolved ids are what scope the search — a
  // refactor could extract the resolution, leave a vestigial call here, scope `/search` from
  // somewhere else, and this would stay green while the defect returned. Nothing static can close
  // that; the BEHAVIOURAL guarantee is
  // test/datamechanics/graph-rename-read-pointer.datamechanics.test.ts, which renames a projected
  // team against real Postgres and asserts the read set still addresses its episodes. This case
  // earns its place only as the cheap tripwire for a leg being unwired wholesale — read it as
  // "the wiring is still named here", not "the wiring is still correct".
  it("every graph read leg still references the pointer authority (presence, not behaviour)", () => {
    // The legs that were defective. Named individually because "no episodeGroupId" is satisfied
    // vacuously by a leg that stops reading the graph at all.
    const legs = [
      "app/api/brain/facts/route.ts",
      "app/api/brain/events/route.ts",
      "app/api/v1/graph-query/route.ts",
    ];
    for (const f of legs) {
      // `code()`, not raw text — this suite strips comments precisely so a guard cannot be
      // satisfied by a comment that merely NAMES the thing it is checking for.
      expect(code(join(ROOT, f)), `${f} must resolve its groups from the pointers`).toContain(
        "visibleTierGroupIds("
      );
    }
    // retrieve.ts is pointer-resolved through the PARTITION path since PRET-6 (the enforced
    // read's `selectEnforcedGraphPartitions` reads stored pointers) — pin that reference, not
    // the tier-groups helper the retirement removed from this file.
    expect(code(join(ROOT, "lib/query/retrieve.ts")), "retrieve resolves groups via the stored-pointer partition read").toContain(
      "selectEnforcedGraphPartitions("
    );
    // The arcs legs resolve through resolveArcScope, which is pointer-resolved already (PRET-3)
    // and is pinned by test/guards/arcs-single-read-path.test.ts.
  });
});
