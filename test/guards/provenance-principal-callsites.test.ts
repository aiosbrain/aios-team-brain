import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * GUARD: a token must never obtain MEMBER provenance semantics (AUDITFIX-1 AC9).
 *
 * Two layers, because they answer two different questions:
 *
 *   1. **The two TOKEN-CAPABLE files** — `lib/query/retrieve.ts`, `lib/query/structured-extras.ts` —
 *      may only ever FORWARD `enforce.principal`. This is an authorization boundary, so it is checked
 *      STRUCTURALLY, against the TypeScript AST. See the walk below for why it is not a regex.
 *   2. **The rest of the tree** — a member literal is legal only at a listed member-only boundary, so
 *      the allow-list doubles as the inventory of "who is asserting memberhood, and on what
 *      authority". This layer stays text-based: it spans ~700 files, it is a coverage inventory
 *      rather than a wall, and its failure mode is a stale allow-list entry, not an escalation.
 *
 * The defect behind all of it: an empty-scoped delegated token received every hand-typed task and
 * decision in the team, reproduced against real Postgres.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Code only — a guard that reads its own prose fires on documentation.
 *
 * The `*` rule is narrow ON PURPOSE. `startsWith("*")` alone deleted GENERATOR METHODS —
 * `*iter() { const principal = "member"; }` vanished entirely, which is a hiding place, and in the
 * FAIL-OPEN direction. A jsdoc continuation is `*` followed by whitespace or end-of-line, or `*​/`;
 * a generator is `*` followed immediately by an identifier. Only the former is stripped.
 *
 * This is layer 2 only. Layer 1 does not use it: the parser owns comments and strings, which is
 * precisely one of the reasons layer 1 is a parser.
 */
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/\/\*.*?\*\//g, " "))
    .filter((l) => {
      const t = l.trim();
      return !(/^\*(\s|$)/.test(t) || t.startsWith("*/") || t.startsWith("//") || t.startsWith("/*"));
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

/* ─────────────────────────── LAYER 1 — the token-capable files, structurally ─────────────────── */

/**
 * Regexes lost this arms race three times, so this layer stopped being one.
 *
 *   · Spec round 3 killed the version that counted references to a shared helper: a token path can
 *     write the value inline and never touch the helper.
 *   · Fable's diff review defeated the literal version with `const principal = "member" as
 *     ProvenancePrincipal` plus a shorthand property. I planted it and confirmed the guard passed
 *     6/6 while the dm token tests reddened on the real leak.
 *   · Codex's diff review then listed six more that still passed: a computed key
 *     `{ ["principal"]: "member" }`, a later `...spread` overwriting the forwarded value,
 *     `enforce!.principal = "member"`, `||=`, `Reflect.set`, `Object.defineProperty`. It also showed
 *     the hand-rolled brace scanner mis-pairing on a nested object, a brace inside a string, or a
 *     destructuring pattern, and `codeOnly` still discarding real code after a block-comment
 *     terminator.
 *
 * Each of those is a new SPELLING of one act, and a text matcher can only enumerate spellings. All of
 * them are syntax, and syntax is what the parser owns — so this walks the tree instead. The
 * brace/comment/string hazards disappear with it.
 *
 * The property, in the two token-capable files:
 *   1. every `principal` property is initialised to EXACTLY `enforce?.principal` — no literal,
 *      constant, alias, computed key, shorthand, or conditional;
 *   2. no object literal carrying `visibleItemIds` may contain a SPREAD, which could overwrite it;
 *   3. nothing ASSIGNS to a `.principal` property, in any assignment operator;
 *   4. `Reflect.set` / `Object.defineProperty` may not target `principal`;
 *   5. every object literal carrying `visibleItemIds` also carries `principal` AND `tokenProjectIds`
 *      (AUDITFIX-7) — the M13 property,
 *      which exists because deleting a forward reddened nothing: it fails closed for a token and
 *      silently drops a MEMBER's hand-typed rows, and no fixture separates that leg from its twin.
 *
 * ⚠️ WHAT THIS STILL DOES NOT CLOSE, stated rather than implied: a ctx obtained wholesale from
 * another module (`const provCtx = buildMemberProvCtx(ids, tier)`) is not analysable without type
 * resolution across files. That gap is accepted on three grounds — it requires adding an exported ctx
 * factory and importing it into a token path, which is a visible reviewable act rather than a
 * one-word edit; the cheap mistakes are all now impossible; and the data-mechanics tier catches the
 * OUTCOME regardless. I verified the third rather than assuming it: planting
 * `principal = "member"` in retrieve.ts reddens
 * `test/datamechanics/token-structured-attenuation.datamechanics.test.ts` on the real leak, both
 * arms. Read this guard as the fast build-failing layer over a tier that independently proves the
 * outcome — not as the only thing between a token and the hand-typed rows.
 */
/** The two fields that carry a principal's AUTHORITY. Both are forward-only, and both are equally
 *  deletable-without-reddening, so every rule below treats them identically. */
const AUTHORITY_FIELDS = new Set(["principal", "tokenProjectIds"]);

function astViolations(code: string, rel = "inline.ts"): string[] {
  const src = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bad: string[] = [];
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;

  /** The ONE permitted initialiser, matched on shape: `enforce?.principal` or `enforce.principal`. */
  const isForwarded = (e: ts.Expression): boolean => {
    const inner = ts.isNonNullExpression(e) ? e.expression : e;
    if (!ts.isPropertyAccessExpression(inner)) return false;
    return ts.isIdentifier(inner.expression) && inner.expression.text === "enforce" && inner.name.text === "principal";
  };

  /** The ONE permitted initialiser for the token project set: `enforce?.tokenProjectIds`. */
  const isForwardedProjects = (e: ts.Expression): boolean => {
    const inner = ts.isNonNullExpression(e) ? e.expression : e;
    if (!ts.isPropertyAccessExpression(inner)) return false;
    return ts.isIdentifier(inner.expression) && inner.expression.text === "enforce" && inner.name.text === "tokenProjectIds";
  };

  /** A property's name, resolving a literal COMPUTED key — the spelling Codex demonstrated. */
  const nameOf = (p: ts.ObjectLiteralElementLike): string | null => {
    if (ts.isSpreadAssignment(p)) return null;
    const n = p.name;
    if (!n) return null;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
    if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) return n.expression.text;
    return null;
  };

  const visit = (node: ts.Node): void => {
    // (3) an assignment INTO an authority property, in any assignment operator (`=`, `||=`, `??=`).
    // ⚠️ BOTH FIELDS, symmetrically (Codex diff review). This checked `principal` only, so the
    // literal could be built correctly and then mutated:
    //     const ctx = { …, tokenProjectIds: enforce?.tokenProjectIds };
    //     ctx.tokenProjectIds = ["out-of-scope-project"];
    // — which passed the object-literal rule and admitted that project. A carry rule that inspects
    // only construction is a rule about the first line, not about the value.
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      AUTHORITY_FIELDS.has(node.left.name.text) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      bad.push(`${at(node)} assigns to .${node.left.name.text} — this file may only FORWARD it`);
    }

    // (4) reaching it reflectively.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = `${node.expression.expression.getText(src)}.${node.expression.name.text}`;
      if (callee === "Reflect.set" || callee === "Object.defineProperty") {
        // These name the field as a STRING ARGUMENT.
        if (node.arguments.some((a) => ts.isStringLiteralLike(a) && AUTHORITY_FIELDS.has(a.text))) {
          bad.push(`${at(node)} sets an authority field via ${callee}`);
        }
      }
      if (callee === "Object.assign") {
        // ⚠️ DIFFERENT SHAPE, and the first version of this rule missed it: `Object.assign` names the
        // field as a KEY INSIDE an object-literal argument, not as a string argument. Reusing the
        // string-argument test read as coverage and provided none — caught by its own mutation
        // surviving.
        for (const a of node.arguments) {
          if (!ts.isObjectLiteralExpression(a)) continue;
          for (const prop of a.properties) {
            const n = nameOf(prop);
            if (n && AUTHORITY_FIELDS.has(n)) bad.push(`${at(prop)} sets .${n} via Object.assign`);
          }
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map(nameOf);

      for (const [i, prop] of node.properties.entries()) {
        if (names[i] !== "principal") continue;
        if (ts.isShorthandPropertyAssignment(prop)) {
          // Shorthand carries no initialiser to inspect, so it can only be hiding a local binding.
          bad.push(`${at(prop)} shorthand \`{ principal }\` — forwarding cannot be spelled that way`);
        } else if (ts.isPropertyAssignment(prop) && !isForwarded(prop.initializer)) {
          // A TYPE position never reaches here: an interface member parses as a PropertySignature,
          // not a PropertyAssignment. The regex version needed an explicit carve-out for that.
          bad.push(`${at(prop)} principal is \`${prop.initializer.getText(src)}\`, not enforce?.principal`);
        }
      }

      if (names.includes("visibleItemIds")) {
        const spread = node.properties.find(ts.isSpreadAssignment);
        // (2) a spread can silently overwrite the forwarded value with one from another module.
        if (spread) bad.push(`${at(spread)} spread into a provenance ctx can overwrite principal`);
        // (5) the M13 property — carry it, don't merely be able to.
        if (!names.includes("principal")) bad.push(`${at(node)} provenance ctx omits principal`);
        // (6) AUDITFIX-7: the token's project set is equally load-bearing and equally deletable.
        // Deleting the forward closes the hand-typed arm for every token — which is EXACTLY today's
        // behaviour, so no token test would notice and no mutation would redden. Same reasoning that
        // put `principal` here: an absent forward is indistinguishable from the fail-closed default.
        if (!names.includes("tokenProjectIds")) {
          bad.push(`${at(node)} provenance ctx omits tokenProjectIds — a token's hand-typed arm closes silently`);
        } else {
          // Fable diff review, LOW: presence alone was ASYMMETRIC with rule (1), which requires
          // `principal` to be initialised to exactly `enforce?.principal`. `tokenProjectIds: undefined`
          // or a locally recomputed set satisfied mere presence — and recomputing the authority is a
          // second oracle read free to disagree with the first, which is the whole reason
          // `delegatedVisibleItemIds` returns it. Same rule, same shape, both fields.
          const prop = node.properties[names.indexOf("tokenProjectIds")];
          if (prop && ts.isPropertyAssignment(prop) && !isForwardedProjects(prop.initializer)) {
            bad.push(`${at(prop)} tokenProjectIds is \`${prop.initializer.getText(src)}\`, not enforce?.tokenProjectIds`);
          } else if (prop && ts.isShorthandPropertyAssignment(prop)) {
            bad.push(`${at(prop)} shorthand \`{ tokenProjectIds }\` — forwarding cannot be spelled that way`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(src);
  return bad;
}

/* ─────────────────────────── LAYER 2 — the tree-wide coverage inventory ──────────────────────── */

/**
 * A member literal being MANUFACTURED, in the shapes it takes across the tree:
 *   · an object property — `principal: "member"`;
 *   · the TS twin's positional 4th argument — `rowVisibleByProvenance(row, ids, tier, "member")`;
 *   · a named constant — `const MEMBER_ONLY_SURFACE = "member" as const`.
 *
 * This layer is an INVENTORY, not a wall — see the header. Its job is to keep the allow-list honest
 * about who asserts memberhood, so a new assertion has to be justified in review.
 */
// The whitespace lives INSIDE the lookahead: `\s*(?!\|)` backtracks to zero width and passes on
// `principal: "member" | "token"`, which is how the first spelling flagged three type declarations.
const MEMBER_PROP = /principal\s*:\s*["'`]member["'`](?!\s*\|)/;
// `[^)]*` stopped at the first `)`, so a twin call containing a nested call
// (`rowVisibleByProvenance(d, getIds(), tier, "member")`) escaped this scan. `[^;]*?` admits the
// nested call while being unable to leave the statement: an argument list contains no `;`.
// (Plain `[\s\S]*?` did leave it — I checked — matching a `"member"` string many lines later in an
// unrelated statement. Only a false POSITIVE, but a guard that cries wolf gets its allow-list widened.)
const MEMBER_TWIN_ARG = /rowVisibleByProvenance\([^;]*?["'`]member["'`]\s*\)/;
// Scoped to a VARIABLE DECLARATION. Dropping the tail requirement outright over-matched two things
// that assert nothing: the type alias `type ProvenancePrincipal = "member" | "token"` and the SQL
// string `a.target_type = 'member'` in lib/auth/welcome-context.ts. Requiring `const|let|var <name>`
// keeps a cast-bearing binding caught and both of those out. The lookbehind excludes comparisons.
const MEMBER_BINDING = /(?:const|let|var)\s+\w+\s*(?::[^=;]*)?=\s*["'`]member["'`]/;
const MEMBER_LITERAL = {
  test: (src: string) => MEMBER_PROP.test(src) || MEMBER_TWIN_ARG.test(src) || MEMBER_BINDING.test(src),
};

describe("guard: a token can never acquire member provenance semantics", () => {
  it("STRUCTURAL: the token-capable files only ever forward, per the TypeScript AST", () => {
    for (const rel of TOKEN_CAPABLE) {
      const bad = astViolations(read(rel), rel);
      expect(bad, `${rel}:\n  ${bad.join("\n  ")}`).toEqual([]);
      // …and they must actually DO the forwarding, or a file with no ctx at all would pass above.
      expect(read(rel), `${rel} must forward the discriminator`).toMatch(/principal:\s*enforce\?\.principal/);
    }
  });

  it("…and the AST walk rejects every spelling the two diff reviews found — non-vacuity", () => {
    // Each of these passed the regex guard at some point in this slice's history. They are kept as
    // negative controls so a future simplification of the walk reddens here rather than silently
    // reopening the hole.
    const FORWARD = "const ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal: enforce?.principal };";
    const EVASIONS: [string, string][] = [
      ["literal", 'const ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal: "member" };'],
      ["named constant", "const ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal: MEMBER_ONLY_SURFACE };"],
      [
        "local binding + shorthand (Fable's HIGH)",
        'const principal = "member" as ProvenancePrincipal;\nconst ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal };',
      ],
      [
        "AUDITFIX-7: tokenProjectIds RECOMPUTED rather than forwarded (a second oracle read free to disagree)",
        "const ctx = { visibleItemIds, teamPosture, tokenProjectIds: await recomputeProjects(), principal: enforce?.principal };",
      ],
      [
        "AUDITFIX-7: tokenProjectIds omitted (closes every token's hand-typed arm SILENTLY)",
        "const ctx = { visibleItemIds, teamPosture, principal: enforce?.principal };",
      ],
      ["computed key", 'const ctx = { visibleItemIds, teamPosture, tokenProjectIds, ["principal"]: "member" };'],
      [
        "spread override",
        'const o = { principal: "member" };\nconst ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal: enforce?.principal, ...o };',
      ],
      ["direct assignment", `${FORWARD}\nenforce!.principal = "member";`],
      // ⚠️ Codex's diff review demonstrated this exact bypass: build the literal CORRECTLY, then
      // mutate it one line later. The object-literal rule inspects construction; it says nothing
      // about the value. Both authority fields, all three reflective shapes.
      ["post-construction mutation of tokenProjectIds", `${FORWARD}\nctx.tokenProjectIds = ["out-of-scope"];`],
      ["post-construction mutation of principal", `${FORWARD}\nctx.principal = "member";`],
      ["Object.assign over tokenProjectIds", `${FORWARD}\nObject.assign(ctx, { "tokenProjectIds": ["out-of-scope"] });`],
      ["Object.assign over principal", `${FORWARD}\nObject.assign(ctx, { "principal": "member" });`],
      ["Reflect.set over tokenProjectIds", `${FORWARD}\nReflect.set(ctx, "tokenProjectIds", ["out-of-scope"]);`],
      ["logical-or assignment", `${FORWARD}\nenforce!.principal ||= "member";`],
      ["Reflect.set", `${FORWARD}\nReflect.set(enforce, "principal", "member");`],
      ["defineProperty", `${FORWARD}\nObject.defineProperty(enforce, "principal", { value: "member" });`],
      ["derived from tier", 'const ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal: tier === "team" ? "member" : "token" };'],
      ["omitted entirely (M13)", "const ctx = { visibleItemIds, teamPosture };"],
      ["as-const literal", 'const ctx = { visibleItemIds, principal: "member" as const };'],
    ];
    for (const [name, code] of EVASIONS) {
      expect(astViolations(code).length, `the AST walk must REJECT: ${name}`).toBeGreaterThan(0);
    }

    // …and it must ACCEPT the one legal shape, or it is a check that always fails.
    expect(astViolations(FORWARD), "forwarding must pass").toEqual([]);
    expect(astViolations("const ctx = { visibleItemIds, teamPosture, tokenProjectIds: enforce?.tokenProjectIds, principal: enforce.principal };")).toEqual([]);
    // The three shapes that broke the hand-rolled scanner, all now handled by the parser.
    expect(
      astViolations('interface E { visibleItemIds: ReadonlySet<string>; principal?: "member" | "token" }'),
      "an interface declares, it does not construct"
    ).toEqual([]);
    expect(astViolations("const { visibleItemIds } = enforce;"), "destructuring is not a construction").toEqual([]);
    expect(
      astViolations('const s = "{ visibleItemIds }";\nconst ctx = { visibleItemIds, tokenProjectIds: enforce?.tokenProjectIds, principal: enforce?.principal };'),
      "a brace inside a string no longer misleads anything"
    ).toEqual([]);
  });

  it("every member literal in the tree sits at a listed member-only boundary", () => {
    const offenders = [...filesUnder("lib"), ...filesUnder("app"), ...filesUnder("scripts")]
      .filter((rel) => !MEMBER_BOUNDARIES.has(rel))
      .filter((rel) => MEMBER_LITERAL.test(codeOnly(read(rel))));
    expect(offenders, "a new member literal must be justified by an authenticated member boundary").toEqual([]);
  });

  it("the tree-wide needle matches what it claims to — non-vacuity", () => {
    // A guard whose regex matches nothing passes forever.
    expect(MEMBER_LITERAL.test('const c = { principal: "member" };')).toBe(true);
    expect(MEMBER_LITERAL.test("const c = { principal: 'member' };")).toBe(true);
    expect(MEMBER_LITERAL.test('principal:"member"')).toBe(true);
    expect(MEMBER_LITERAL.test('rowVisibleByProvenance(d, ids, tier, "member")')).toBe(true);
    expect(MEMBER_LITERAL.test('rowVisibleByProvenance(d, getIds(), tier, "member")'), "nested call").toBe(true);
    expect(MEMBER_LITERAL.test('const MEMBER_ONLY_SURFACE = "member" as const;')).toBe(true);
    expect(MEMBER_LITERAL.test('const principal = "member" as ProvenancePrincipal;')).toBe(true);
    // …and the shapes that assert NOTHING and must not be flagged.
    expect(MEMBER_LITERAL.test("principal: enforce?.principal"), "forwarding").toBe(false);
    expect(MEMBER_LITERAL.test('principal: "member" | "token";'), "a union declares").toBe(false);
    expect(MEMBER_LITERAL.test('export type P = "member" | "token";'), "a type alias declares").toBe(false);
    expect(MEMBER_LITERAL.test('const ok = enforce?.principal === "member";'), "a comparison reads").toBe(false);
    expect(MEMBER_LITERAL.test('if (p !== "member") return;'), "so does this one").toBe(false);
    expect(MEMBER_LITERAL.test("a.target_type = 'member' and a.action"), "a SQL string").toBe(false);
    expect(
      MEMBER_LITERAL.test('rowVisibleByProvenance(d, ids, tier, principal);\nconst x = 1;\nlog("member")'),
      "the twin needle must stay inside its own statement"
    ).toBe(false);
    // …and codeOnly must not swallow a generator method, which would be a hiding place.
    expect(codeOnly('class C {\n  *iter() { const principal = "member"; }\n}')).toContain("principal");
    expect(codeOnly(" * a jsdoc continuation line"), "prose is still stripped").not.toContain("jsdoc");
  });

  it("the allow-list is honest — every listed boundary really does assert memberhood", () => {
    const stale = [...MEMBER_BOUNDARIES].filter((rel) => !MEMBER_LITERAL.test(codeOnly(read(rel))));
    expect(
      stale,
      "TWO possible causes, and the wrong one is the tempting one: EITHER this file LOST a member " +
        "assertion it needs — a silent member regression, since an absent discriminator closes the " +
        "hand-typed arm — OR the file genuinely no longer needs the entry. Check which before " +
        "deleting the allow-list line."
    ).toEqual([]);
  });

  it("AUDITFIX-7: the token arm's posture-free pin stays coupled to the external-delegation refusal", () => {
    // Fable diff review, MEDIUM. `unsourcedAdmission`'s token branch deliberately does NOT consult
    // `teamPosture` — a token's wall is its project authority. That is only SAFE because
    // `verifyAgentToken` refuses external-tier delegation outright, so no live token is ever at
    // external posture. If that refusal is lifted while the pin stands, an external-posture TOKEN
    // would be admitted where its own external LAUNCHER is closed — the token exceeding its
    // launcher, which lib/access/enforce.ts states can never happen.
    //
    // The coupling was written in a comment and enforced by nothing. Now deleting either end reddens.
    const tokens = read("lib/access/agent-tokens.ts");
    expect(
      tokens,
      "verifyAgentToken must still refuse external-tier delegation — the token arm's posture-free pin depends on it"
    ).toMatch(/if\s*\(\s*effectiveTier\s*===\s*"external"\s*\)\s*return\s+null\s*;/);

    const policy = read("lib/access/provenance-sql.ts");
    expect(
      policy,
      "if the token arm ever DOES consult teamPosture, this guard has outlived its premise — delete it deliberately"
    ).toMatch(/if \(ctx\.principal === "token"\) \{[\s\S]{0,1200}?const ids = ctx\.tokenProjectIds;/);
  });
});