import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: a token must never obtain MEMBER provenance semantics (AUDITFIX-1 AC9).
 *
 * WHY THIS SHAPE. The first version of this guard counted references to a shared "member context"
 * helper. Review round 3 killed it in one line: a token-capable path can write
 * `principal: "member"` inline and never touch the helper, so the guard measured a spelling rather
 * than the security property. This one enumerates every place the discriminator can be MANUFACTURED.
 *
 * The property: the two TOKEN-CAPABLE files may only FORWARD `enforce.principal`. They may not
 * contain a member literal at all — that is the exact edit that would reopen the reproduced leak, in
 * which an empty-scoped token received every hand-typed task and decision in the team.
 *
 * Everywhere else, a member literal is legal only at a listed member-only boundary, so the allow-list
 * doubles as the inventory of "who is asserting memberhood, and on what authority".
 *
 * ⚠️ WHAT THIS GUARD DOES NOT CLOSE, stated rather than implied. It reads text, so a ctx obtained
 * WHOLESALE from another module — `const provCtx = buildMemberProvCtx(ids, tier)`, with the factory
 * exported from an allow-listed file — is invisible to every scan here. That gap is accepted, not
 * overlooked, on three grounds: (a) it requires adding an exported ctx factory and importing it into
 * a token path, which is a visible, reviewable act rather than a one-word edit; (b) the guard's job
 * is to make the CHEAP mistakes impossible, and the cheap mistakes are the literal, the constant,
 * the alias, the shorthand and the omission — all now caught; (c) the data-mechanics tier catches
 * the OUTCOME regardless. I verified (c) rather than assuming it: planting
 * `principal = "member"` in retrieve.ts reddens
 * `token-structured-attenuation.datamechanics.test.ts` on the real leak, both arms.
 *
 * So this guard is the fast, build-failing layer over a tier that independently proves the outcome.
 * Do not read it as the only thing standing between a token and the hand-typed rows.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Code only — a guard that reads its own prose fires on documentation. */
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/\/\*.*?\*\//g, " "))
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");

/** Files that see a delegated token and must therefore only ever FORWARD the discriminator. */
const TOKEN_CAPABLE = ["lib/query/retrieve.ts", "lib/query/structured-extras.ts"];

/**
 * Member-only boundaries permitted to assert memberhood, each with the authority that makes it true.
 * `authenticateApiKey` accepts `aios_` keys only, so an `aiosd_` bearer cannot reach an API route
 * listed here (lib/api/auth.ts).
 */
const MEMBER_BOUNDARIES = new Set([
  // The named constant (`MEMBER_ONLY_SURFACE`) feeding the three project-row helpers. Its authority
  // is call-site enumeration: every caller is a session page or an `aios_` member route.
  "lib/access/enforce.ts",
  // NOT lib/metrics/pulse.ts: its absent-ctx fallback used to synthesise "member", which §2d
  // forbids outright. It now synthesises nothing and the real ctx arrives from the page below.
  "lib/dashboard/work-timeline.ts", // session-authenticated timeline
  "app/api/v1/decisions/route.ts", // aios_ member key; authenticateApiKey rejects aiosd_
  // Both found by the dm tier, NOT by the spec's §0 inventory, which said "exactly 7 consumers"
  // and was wrong by two. Omitting the discriminator here closed the hand-typed arm and dropped
  // every UI-origin task out of the writeback feed (tasks-sync-origin-feed reddened).
  "app/api/v1/tasks/route.ts", // aios_ member key; authenticateApiKey rejects aiosd_
  "app/t/[team]/people/[handle]/page.tsx", // session member; reaches the predicate via deriveProjects
  "app/api/v1/query/route.ts", // the MEMBER branch, after authenticateApiKey (the token branch forwards "token")
  "app/api/dashboard/query/route.ts", // session member
  "app/t/[team]/page.tsx",
  "app/t/[team]/tasks/page.tsx",
  "app/t/[team]/decisions/page.tsx", // TS twin, positional
  "app/t/[team]/projects/[project]/page.tsx", // TS twin, positional
]);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/**
 * A member literal being MANUFACTURED, in either shape it can take:
 *   · an object property — `principal: "member"`;
 *   · the TS twin's positional 4th argument — `rowVisibleByProvenance(row, ids, tier, "member")`.
 *
 * The negative lookahead excludes TYPE positions (`principal: "member" | "token"`), which are
 * declarations rather than assertions — the first version of this guard flagged three of them and
 * would have taught the next reader to widen the allow-list instead of tightening the needle.
 */
// The whitespace lives INSIDE the lookahead: `\s*(?!\|)` backtracks to zero width and passes on
// `principal: "member" | "token"`, which is how the first spelling flagged three type declarations.
const MEMBER_PROP = /principal\s*:\s*["'`]member["'`](?!\s*\|)/;
// `[^)]*` stopped at the first `)`, so a twin call containing a nested call
// (`rowVisibleByProvenance(d, getIds(), tier, "member")`) escaped the tree-wide scan. `[\s\S]*?`
// is lazy, so it still cannot run past the call it is matching.
const MEMBER_TWIN_ARG = /rowVisibleByProvenance\([\s\S]*?["'`]member["'`]\s*\)/;
/**
 * …and the shape a NAMED CONSTANT takes — `const MEMBER_ONLY_SURFACE = "member" as const`.
 *
 * This third needle exists because the guard failed its own test: `lib/access/enforce.ts` names the
 * value once instead of repeating a literal, and the two needles above scored that file clean. The
 * escalation it left open is the dangerous one — `import { MEMBER_ONLY_SURFACE }` into a
 * token-capable file and write `principal: MEMBER_ONLY_SURFACE`, and nothing here fires. Round 3
 * killed the FIRST version of this guard for measuring a spelling; naming a constant is just
 * another spelling.
 */
// The lookbehind matters: without it this fires on `enforce?.principal === "member"`, a
// COMPARISON — which retrieve.ts legitimately performs (`serveOrgStructural`) and which asserts
// nothing. Reading a discriminator is not manufacturing one.
// No TAIL requirement. The first spelling demanded `as const` or `;`, and Fable's diff review
// defeated it in one line: `const principal = "member" as ProvenancePrincipal;` — a different cast,
// so the needle missed, and the guard passed 6/6 with a hardcoded member principal in retrieve.ts.
// I planted that exact code and confirmed it BOTH evaded the guard AND reddened the dm token tests,
// so the guard was failing at the one job its header claims. Over-matching a binding is the safe
// direction: the tree-wide scan already excludes comparisons via the lookbehind.
// Scoped to a VARIABLE DECLARATION. Dropping the tail requirement outright over-matched two things
// that assert nothing: the type alias `type ProvenancePrincipal = "member" | "token"` and the SQL
// string `a.target_type = 'member'` in lib/auth/welcome-context.ts. Requiring `const|let|var <name>`
// keeps the bypass caught (`const principal = "member" as ProvenancePrincipal`) and both of those out.
const MEMBER_BINDING = /(?:const|let|var)\s+\w+\s*(?::[^=;]*)?=\s*["'`]member["'`]/;

/**
 * …and the SHORTHAND property, which has no colon and was therefore invisible to every scan above:
 * `const provCtx = { visibleItemIds, teamPosture, principal }`. This is the second half of the same
 * bypass, and it is the shape an author naturally reaches for the moment the guard reddens on
 * `principal: "member"` — extract to a variable until green. A guard that teaches its own evasion is
 * worse than none, so shorthand is forbidden outright in the token-capable files: those may only
 * forward, and forwarding cannot be spelled as shorthand.
 */
const MEMBER_SHORTHAND = /[{,]\s*principal\s*[,}]/;
const MEMBER_LITERAL = {
  test: (src: string) => MEMBER_PROP.test(src) || MEMBER_TWIN_ARG.test(src) || MEMBER_BINDING.test(src),
};

/**
 * The spelling-INDEPENDENT half, for the two files that see a token: every `principal` in a VALUE
 * position must be the forwarded expression, whatever it is spelled as. A literal, a named constant,
 * an imported alias and a re-derivation from `tier` all fail this — the needles above can only catch
 * the shapes someone thought to enumerate.
 *
 * Type positions are excluded because they are declarations, not assertions: a union (`"member" |
 * "token"`) or a type name (`ProvenancePrincipal`, uppercase by TS convention).
 */
/**
 * …and the OTHER half of the property: a ctx that never mentions `principal` at all.
 *
 * Found by mutation, not by review. Deleting retrieve's forward to `matchingDecisions` reddened
 * NOTHING: an absent discriminator closes the hand-typed arm, so a token's outcome is identical and
 * every token assertion still passes. What silently changes is the MEMBER's — that leg stops serving
 * their hand-typed decisions — and no test separates it from the recency window that serves the same
 * rows. A surviving mutation means the suite proves nothing there, so the property moves here:
 * in a token-capable file, every provenance ctx must CARRY the discriminator, not merely be able to.
 *
 * Returns the ctx literals that omit it, by their opening line.
 */
function ctxLiteralsMissingPrincipal(code: string): string[] {
  const out: string[] = [];
  // Shorthand counts too (`{ visibleItemIds, teamPosture }`) — anchoring on the colon alone let a
  // whole construction shape through, which is the same class round 3 twice killed this guard for.
  for (const m of code.matchAll(/visibleItemIds\s*[,:}]/g)) {
    // Walk back to the `{` that opens this object literal, then forward to its match.
    let open = m.index!;
    while (open > 0 && code[open] !== "{") open--;
    let depth = 0;
    let close = open;
    for (; close < code.length; close++) {
      if (code[close] === "{") depth++;
      else if (code[close] === "}" && --depth === 0) break;
    }
    const literal = code.slice(open, close + 1);
    // A TYPE declaration (`{ visibleItemIds: ReadonlySet<string>; ... }`) states the shape and is
    // not a construction; it is excluded the same way the assignment scan excludes unions.
    if (/ReadonlySet<|readonly string\[\]/.test(literal)) continue;
    if (!/principal\s*[,:}]/.test(literal)) out.push(literal.split("\n")[1]?.trim() ?? literal.slice(0, 60));
  }
  return out;
}

const FORWARDED = /^enforce\??\.principal$/;
function unforwardedPrincipalAssignments(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/principal\s*\??\s*:\s*([^,;\n}]+)/g)) {
    const rhs = m[1].trim();
    if (rhs.includes("|")) continue; // a union type declaration
    // A TYPE name is PascalCase (`ProvenancePrincipal`). A CONSTANT is SCREAMING_SNAKE
    // (`MEMBER_ONLY_SURFACE`) — and a bare `/^[A-Z]/` skipped both, which let the exact escalation
    // this function exists to catch walk straight through it.
    if (/^[A-Z][a-zA-Z0-9]*$/.test(rhs) && /[a-z]/.test(rhs)) continue;
    if (FORWARDED.test(rhs)) continue; // the one permitted shape
    out.push(rhs);
  }
  return out;
}

describe("guard: a token can never acquire member provenance semantics", () => {
  it("the token-capable files contain NO member literal — they may only forward", () => {
    for (const rel of TOKEN_CAPABLE) {
      const code = codeOnly(read(rel));
      expect(MEMBER_LITERAL.test(code), `${rel} must forward enforce.principal, never assert "member"`).toBe(false);
      expect(
        MEMBER_SHORTHAND.test(code),
        `${rel} may not use shorthand \`{ principal }\` — forwarding cannot be spelled that way, so it can only be hiding a local binding`
      ).toBe(false);
      expect(code, `${rel} must actually forward the discriminator`).toMatch(/principal:\s*enforce\?\.principal/);
    }
  });

  it("…and every principal they ASSIGN is the forwarded expression — no literal, constant or alias", () => {
    // The property, not the spelling. `principal: MEMBER_ONLY_SURFACE` passes all three needles
    // above and reopens the leak; it fails here.
    for (const rel of TOKEN_CAPABLE) {
      const bad = unforwardedPrincipalAssignments(codeOnly(read(rel)));
      expect(bad, `${rel} may only ever assign enforce?.principal — found: ${bad.join(", ")}`).toEqual([]);
    }
  });

  it("…and every provenance ctx they BUILD carries the discriminator — none may omit it", () => {
    for (const rel of TOKEN_CAPABLE) {
      const missing = ctxLiteralsMissingPrincipal(codeOnly(read(rel)));
      expect(missing, `${rel} builds a provenance ctx with no principal: ${missing.join(" | ")}`).toEqual([]);
    }
  });

  it("every member literal in the tree sits at a listed member-only boundary", () => {
    const offenders = [...filesUnder("lib"), ...filesUnder("app"), ...filesUnder("scripts")]
      .filter((rel) => !MEMBER_BOUNDARIES.has(rel))
      .filter((rel) => MEMBER_LITERAL.test(codeOnly(read(rel))));
    expect(offenders, "a new member literal must be justified by an authenticated member boundary").toEqual([]);
  });

  it("the needle matches what it claims to — non-vacuity", () => {
    // A guard whose regex matches nothing passes forever.
    expect(MEMBER_LITERAL.test('const c = { principal: "member" };')).toBe(true);
    expect(MEMBER_LITERAL.test("const c = { principal: 'member' };")).toBe(true);
    expect(MEMBER_LITERAL.test('principal:"member"')).toBe(true);
    expect(MEMBER_LITERAL.test('rowVisibleByProvenance(d, ids, tier, "member")')).toBe(true);
    // Forwarding is the permitted shape, and a TYPE declaration is not an assertion.
    expect(MEMBER_LITERAL.test("principal: enforce?.principal")).toBe(false);
    expect(MEMBER_LITERAL.test('principal: "member" | "token";')).toBe(false);
    expect(MEMBER_LITERAL.test('principal: "member" | "token" | undefined')).toBe(false);
    expect(MEMBER_LITERAL.test('principal: "member" as const')).toBe(true);
    // The named-constant shape the first two needles missed — the reason this one exists.
    expect(MEMBER_LITERAL.test('const MEMBER_ONLY_SURFACE = "member" as const;')).toBe(true);
    expect(MEMBER_LITERAL.test("const M = 'member';")).toBe(true);
    // …but a COMPARISON is a read, not an assertion — retrieve.ts does exactly this, legally.
    expect(MEMBER_LITERAL.test('const ok = enforce?.principal === "member";')).toBe(false);
    expect(MEMBER_LITERAL.test('if (p !== "member") return;')).toBe(false);
    // …and the forwarding check that catches it wherever it is IMPORTED rather than declared.
    expect(unforwardedPrincipalAssignments("principal: MEMBER_ONLY_SURFACE,")).toEqual(["MEMBER_ONLY_SURFACE"]);
    expect(unforwardedPrincipalAssignments('principal: tier === "team" ? "member" : "token",'))
      .toEqual(['tier === "team" ? "member" : "token"']);
    expect(unforwardedPrincipalAssignments("principal: enforce?.principal,")).toEqual([]);
    expect(unforwardedPrincipalAssignments('principal: "member" | "token";'), "a union is a declaration").toEqual([]);
    expect(unforwardedPrincipalAssignments("principal?: ProvenancePrincipal"), "a type name is a declaration").toEqual([]);
    // THE BYPASS Fable demonstrated, pinned in both halves so it cannot come back.
    expect(MEMBER_LITERAL.test('const principal = "member" as ProvenancePrincipal;')).toBe(true);
    expect(MEMBER_LITERAL.test('const principal = "member"')).toBe(true);
    expect(MEMBER_SHORTHAND.test("const c = { visibleItemIds, teamPosture, principal };")).toBe(true);
    expect(MEMBER_SHORTHAND.test("const c = { principal };")).toBe(true);
    expect(MEMBER_SHORTHAND.test("principal: enforce?.principal,"), "forwarding is not shorthand").toBe(false);
    // …and the shorthand omission the colon-anchored scan could not see.
    expect(ctxLiteralsMissingPrincipal("f({\n  visibleItemIds,\n  teamPosture,\n})").length).toBe(1);
    expect(ctxLiteralsMissingPrincipal("f({\n  visibleItemIds,\n  teamPosture,\n  principal,\n})")).toEqual([]);
    // …and a twin call with a nested call in its arguments.
    expect(MEMBER_LITERAL.test('rowVisibleByProvenance(d, getIds(), tier, "member")')).toBe(true);
    // The omission scan: a ctx with no discriminator at all — the shape a surviving mutation found.
    expect(ctxLiteralsMissingPrincipal("f({\n  visibleItemIds: ids,\n  teamPosture: true,\n})").length).toBe(1);
    expect(ctxLiteralsMissingPrincipal("f({\n  visibleItemIds: ids,\n  principal: enforce?.principal,\n})")).toEqual([]);
    expect(
      ctxLiteralsMissingPrincipal("interface X {\n  visibleItemIds: ReadonlySet<string>;\n}"),
      "a type declaration is not a construction"
    ).toEqual([]);
  });

  it("the allow-list is honest — every listed boundary really does assert memberhood", () => {
    // A stale allow-list entry is permission granted to a file that no longer needs it.
    const stale = [...MEMBER_BOUNDARIES].filter((rel) => !MEMBER_LITERAL.test(codeOnly(read(rel))));
    expect(
      stale,
      "TWO possible causes, and the wrong one is the tempting one: EITHER this file LOST a member " +
        "assertion it needs — a silent member regression, since an absent discriminator closes the " +
        "hand-typed arm — OR the file genuinely no longer needs the entry. Check which before " +
        "deleting the allow-list line."
    ).toEqual([]);
  });
});
