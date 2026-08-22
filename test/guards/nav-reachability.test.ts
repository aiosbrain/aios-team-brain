import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNavItems } from "@/lib/dashboard/nav-items";
import type { NavEntry, NavLeaf } from "@/components/team-nav";

/**
 * Nav reachability guard (SKILLNAV-1).
 *
 * WHY THIS EXISTS — an observed bug, not a hypothetical. The shared-skills catalog
 * (`/t/<team>/library/skills`) shipped with a top-level nav entry (3feb311). `5138047` then REMOVED
 * that entry, because the Library PAGE had gained a kind-chip linking to it; `5509ca9` (#213) turned
 * library/page.tsx into a redirect, destroying the chip and the last path in. (Corrected here in
 * round 3 — an earlier draft blamed #213 for cutting the nav entry, which `git show 5138047`
 * disproves. The account in lib/dashboard/nav-items.ts is the one to trust.) The only remaining
 * reference is `app/t/[team]/skills/page.tsx`, a bare redirect ALIAS — reachable if you already know
 * the old URL, discoverable by no one. So the catalog stayed authenticated, deployed and holding 22
 * published skills while being unreachable. Nothing failed, because nothing pinned it.
 *
 * The guard CALLS `buildNavItems` rather than grepping the layout. That distinction is the whole
 * point: a source-text guard cannot tell a rendered entry from one sitting inside a block comment,
 * and cannot see an entry that moved behind `if (role === "admin")` — both leave the nav broken for
 * real users while the guard stays green. An earlier draft of this file had exactly that hole; the
 * adversarial review broke it with a two-line probe.
 *
 * Two invariants, one per direction of the failure:
 *   1. NO DEAD LINKS — every nav href resolves to a real route file.
 *   2. NO ORPHANED CATALOGS — browsable surfaces must appear in the nav, for every role that may see
 *      them. This is the one that actually happened.
 */

const PAGES = join(import.meta.dirname, "..", "..", "app", "t", "[team]");
const BASE = "/t/acme";

/** Every role whose nav must be checked; an entry hidden from some roles is still a regression. */
const ROLES = ["member", "lead", "admin"] as const;

function isSection(e: NavEntry): e is { label: string; children: NavLeaf[] } {
  return (e as { children?: unknown }).children !== undefined;
}

/** Flatten primary entries + section children into the leaves a user can actually click. */
export function leaves(items: NavEntry[]): NavLeaf[] {
  return items.flatMap((e) => (isSection(e) ? e.children : [e]));
}

/**
 * Route path → the page file that serves it. `/t/acme` (the base itself) is the index page.
 * Every page under `app/t/[team]` is `.tsx` today; the other extensions are accepted so a routine
 * rename cannot turn this guard into a false blocker. Route groups `(x)` and parallel slots `@x`
 * are NOT modelled — none exist under this subtree, and inventing support for them would be
 * untested code in a guard.
 */
const PAGE_EXTS = ["tsx", "ts", "jsx", "js"] as const;
function routeFile(href: string): string | null {
  const dir = join(PAGES, href.slice(BASE.length).replace(/^\//, ""));
  return PAGE_EXTS.map((e) => join(dir, `page.${e}`)).find(existsSync) ?? null;
}
function routeExists(href: string): boolean {
  return routeFile(href) !== null;
}

/** Surfaces that exist to be browsed. Add a row when one ships — that is the point. */
const MUST_BE_REACHABLE: [label: string, path: string][] = [["Skills", "/library/skills"]];

describe("nav reachability", () => {
  it("the builder returns a real nav (non-vacuity: an empty nav must not pass anything below)", () => {
    const l = leaves(buildNavItems({ base: BASE, role: "member" }));
    expect(l.length, "buildNavItems returned almost nothing — every assertion below would be vacuous").toBeGreaterThanOrEqual(5);
    expect(l.map((x) => x.label)).toContain("Pulse");
  });

  it("the builder is role-sensitive, and the guard sees that (non-vacuity)", () => {
    const admin = leaves(buildNavItems({ base: BASE, role: "admin" })).map((x) => x.label);
    const member = leaves(buildNavItems({ base: BASE, role: "member" })).map((x) => x.label);
    expect(admin, "admin should get the Admin entry").toContain("Admin");
    expect(member, "a non-admin must NOT get the Admin entry — if this fails the role arg is ignored").not.toContain("Admin");
  });

  for (const role of ROLES) {
    it(`every nav href resolves to a real route file — role: ${role} (no dead links)`, () => {
      const dead = leaves(buildNavItems({ base: BASE, role }))
        .filter((n) => !routeExists(n.href))
        .map((n) => `${n.label} → ${n.href}`);
      expect(dead, `Nav entries pointing at routes that do not exist:\n${dead.join("\n")}`).toEqual([]);
    });

    it(`browsable catalogs appear in the nav — role: ${role}`, () => {
      const hrefs = new Set(leaves(buildNavItems({ base: BASE, role })).map((n) => n.href));
      const orphaned = MUST_BE_REACHABLE.filter(([, p]) => !hrefs.has(`${BASE}${p}`)).map(([l, p]) => `${l} (${p})`);
      expect(
        orphaned,
        `Built, deployed, data-bearing surfaces with NO way in from the nav for role "${role}":\n` +
          `${orphaned.join("\n")}\n` +
          `This is the SKILLNAV-1 regression: /library/skills sat unreachable for weeks while holding\n` +
          `22 published skills. If a catalog is genuinely retired, delete its route AND its row here.`
      ).toEqual([]);
    });
  }

  it("the route resolver discriminates (non-vacuity: a fabricated route must NOT resolve)", () => {
    expect(routeExists(`${BASE}/query`)).toBe(true);
    expect(routeExists(`${BASE}/definitely-not-a-route`)).toBe(false);
  });

  it("every must-be-reachable catalog actually exists on disk (the list can't rot)", () => {
    const missing = MUST_BE_REACHABLE.filter(([, p]) => !routeExists(`${BASE}${p}`)).map(([l]) => l);
    expect(missing, `listed as must-be-reachable but has no route file: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * ROUND-2 FOLD (call-site pin). The assertions above prove what `buildNavItems` RETURNS. They say
   * nothing about whether the layout renders it: `<TeamNav items={items.filter(e => e.label !==
   * "Skills")} />` removes Skills for every user with all of the above still green. This pins the
   * DISTINCT property — the wiring — so the two layers cannot mask each other's mutations.
   */
  it("the layout renders the builder's nav unmodified (call-site pin)", () => {
    const src = readFileSync(join(PAGES, "layout.tsx"), "utf8");
    expect(src, "layout must build its nav via buildNavItems").toMatch(/const\s+items\s*=\s*buildNavItems\(/);
    expect(
      src,
      "layout must pass the built nav to TeamNav UNMODIFIED — any .filter/.slice/.map between the\n" +
        "builder and the render is a way to drop an entry while the builder-level assertions stay green"
    ).toMatch(/<TeamNav\s+items=\{items\}\s*\/>/);
  });

  it("the call-site pin rejects a transformed nav (non-vacuity)", () => {
    const pass = /<TeamNav\s+items=\{items\}\s*\/>/;
    expect(pass.test("<TeamNav items={items} />")).toBe(true);
    expect(pass.test('<TeamNav items={items.filter((e) => e.label !== "Skills")} />')).toBe(false);
  });

  /**
   * ROUND-3 FOLD (Fable). The pin above proves the good render EXISTS somewhere in the file — not
   * that it is the one that runs. That reopens, one level up, the exact hole the builder extraction
   * closed: `{/* <TeamNav items={items} /> *[/]}` next to a real `<TeamNav items={pruned} />`
   * satisfies the regex, and so does a conditional `{flag && <TeamNav items={items} />}`. Both were
   * confirmed with a direct probe. Requiring EXACTLY ONE occurrence makes the matched render the
   * rendered one; the in-place `items.splice(...)` variant is additionally blocked at runtime by
   * `Object.freeze` in the builder.
   */
  it("the layout renders TeamNav exactly once (a second copy makes the pin meaningless)", () => {
    const src = readFileSync(join(PAGES, "layout.tsx"), "utf8");
    const occurrences = src.match(/<TeamNav\b/g) ?? [];
    expect(
      occurrences.length,
      "layout.tsx must contain exactly ONE <TeamNav ...>. A second occurrence — even commented out —\n" +
        "lets the pin match a render that never runs while a different, transformed one does."
    ).toBe(1);
  });

  it("the layout does not mutate the nav in place between builder and render", () => {
    const src = readFileSync(join(PAGES, "layout.tsx"), "utf8");
    const mutators = src.match(/\bitems\.(splice|push|pop|shift|unshift|sort|reverse|fill|copyWithin)\s*\(|\bitems\.length\s*=/g) ?? [];
    expect(
      mutators,
      `In-place mutation of the nav in layout.tsx: ${mutators.join(", ")}. \`const\` blocks reassignment,\n` +
        `not mutation — and the builder-level assertions call buildNavItems() fresh, so they cannot see it.`
    ).toEqual([]);
  });

  it("the once-only and mutation pins discriminate (non-vacuity)", () => {
    const once = (src: string) => (src.match(/<TeamNav\b/g) ?? []).length;
    expect(once("<TeamNav items={items} />")).toBe(1);
    expect(once('{/* <TeamNav items={items} /> */}\n<TeamNav items={pruned} />'), "a commented-out copy must break the once-only pin").toBe(2);
    const mut = /\bitems\.(splice|push|pop|shift|unshift|sort|reverse|fill|copyWithin)\s*\(|\bitems\.length\s*=/g;
    expect("items.splice(4, 1);".match(mut)).not.toEqual(null);
    expect("const items = buildNavItems({ base, role: me.role });".match(mut)).toEqual(null);
  });

  it("the builder's return is frozen, so an in-place drop throws instead of silently passing", () => {
    const nav = buildNavItems({ base: BASE, role: "member" });
    expect(Object.isFrozen(nav), "buildNavItems must return a frozen array").toBe(true);
    expect(() => (nav as NavEntry[]).splice(0, 1)).toThrow();
  });

  /**
   * ROUND-2 FOLD (redirect stub). A route FILE existing does not mean the surface renders: make
   * SkillsPage `redirect(...)` immediately and every existence check still passes. Scoped to
   * browsable catalogs deliberately — `admin/page.tsx` is a legitimate redirect stub, so a blanket
   * rule here would be a false blocker.
   */
  it("browsable catalogs render content — not a redirect stub", () => {
    const stubs = MUST_BE_REACHABLE.filter(([, p]) => {
      const f = routeFile(`${BASE}${p}`);
      // `return redirect(...)`, `permanentRedirect`, and `notFound()` all render nothing and were
      // all missed by the original bare-`redirect(` matcher (Fable review, round 3).
      return f !== null && /^\s*(?:return\s+)?(?:permanentR|r)edirect\(|^\s*(?:return\s+)?notFound\(/m.test(readFileSync(f, "utf8"));
    }).map(([l]) => l);
    expect(
      stubs,
      `Catalogs whose page immediately redirects — reachable in the nav, but there is nothing to\n` +
        `reach: ${stubs.join(", ")}`
    ).toEqual([]);
  });
});
