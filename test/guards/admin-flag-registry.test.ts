import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ADMIN_BOOLEAN_FLAGS, TASK_BOOLEAN_FLAGS } from "@/lib/admin/args";
import { parseConfirmFlags } from "@/lib/access/materialize-command";

function unwrap(node: ts.Node): ts.Node {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}
function flagName(node: ts.Node): string | undefined {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "flags") return node.name.text;
  if (ts.isElementAccessExpression(node) && node.expression.getText() === "flags" && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}
/** The OUTERMOST cast of a chain — `x as unknown as boolean` must be judged by `boolean`. */
function unwrapType(node: ts.AsExpression): ts.Node {
  return node.expression;
}
type TypeVerdict = "boolean" | "value" | "unresolvable";
function classifyType(t: ts.TypeNode): TypeVerdict {
  if (t.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (ts.isLiteralTypeNode(t) && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(t.literal.kind)) return "boolean";
  if (t.kind === ts.SyntaxKind.StringKeyword || t.kind === ts.SyntaxKind.NumberKeyword) return "value";
  if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return "value";
  if (ts.isUnionTypeNode(t)) {
    // Drop the nullish members, then: all-boolean => boolean; any value member => value (this is the
    // boundary `flags.labels as string | boolean | undefined` sits on, and it must stay a VALUE).
    const parts = t.types.filter(m => m.kind !== ts.SyntaxKind.UndefinedKeyword && m.kind !== ts.SyntaxKind.NullKeyword
      && !(ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword));
    const vs = parts.map(classifyType);
    if (vs.length && vs.every(v => v === "boolean")) return "boolean";
    if (vs.some(v => v === "value")) return "value";
    return "unresolvable";
  }
  return "unresolvable"; // any, unknown, as const, TypeReference, everything else
}
function classify(source: string) {
  const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
  const booleans = new Set<string>();
  const values = new Set<string>();
  const add = (set: Set<string>, node: ts.Node) => { const name = flagName(node); if (name) set.add(name); };
  const condition = (node: ts.Node): void => {
    node = unwrap(node);
    add(booleans, node);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      condition(node.left);
      condition(node.right);
    }
  };
  const seen = new Set<string>();
  const visit = (node: ts.Node) => {
    const anyName = flagName(node);
    if (anyName) seen.add(anyName);
    if (ts.isCallExpression(node) && node.expression.getText() === "Boolean") node.arguments.forEach(arg => add(booleans, arg));
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) add(booleans, node.operand);
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) condition(node.expression);
    if (ts.isConditionalExpression(node)) condition(node.condition);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) add(booleans, node.left);
    // An `as` cast declares intent. A BOOLEAN-typed cast is a boolean read (so the name must be
    // registered); anything else is a value read. Accepting every cast as a "value" — which an
    // earlier fold did, to classify `flags.tier as "team" | "external"` — let
    // `const w = flags.wipe as boolean; if (w) destroy();` past the guard with NO violation:
    // not a boolean, not unregistered, not unclassified. Found by attacking my own fold.
    // An `as` cast declares intent, and the classification must FAIL CLOSED when the cast does not
    // actually declare one. Two earlier attempts both leaked, each time widening the door I had just
    // narrowed: accepting every cast as a "value" let `flags.wipe as boolean` through, and then
    // checking only BooleanKeyword/true/false let `flags.wipe as boolean | undefined` — the spelling
    // a careful author reaches for, given `Flags = Record<string, string | boolean>` — through too.
    // So: boolean-only asserted type => boolean read (must be registered); a type that is clearly a
    // value => value read; ANYTHING UNRESOLVABLE (`any`, `unknown`, `as const`, a type reference a
    // syntactic classifier cannot follow) => NEITHER, so the forall clause fires.
    if (ts.isAsExpression(node) && !ts.isAsExpression(unwrapType(node))) {
      const verdict = classifyType(node.type);
      if (verdict === "boolean") add(booleans, node.expression);
      else if (verdict === "value") add(values, node.expression);
      // else: unresolvable — classify NOTHING, so the read stays in `seen` only and the
      // forall clause reports it as `unclassified read: <name>`.
    }
    if (ts.isBinaryExpression(node)) {
      for (const [left,right] of [[node.left,node.right],[node.right,node.left]]) {
        if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right) && right.text === "string") add(values, left.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {booleans,values,seen};
}
function violations(source: string, registry: readonly string[]) {
  const {booleans,values,seen} = classify(source);
  return [
    ...[...booleans].filter(name => !registry.includes(name)).map(name => `unregistered boolean: ${name}`),
    ...[...values].filter(name => registry.includes(name)).map(name => `registered value: ${name}`),
    ...[...booleans].filter(name => values.has(name)).map(name => `both classes: ${name}`),
    // THE FORALL CLAUSE. Without it this guard is existential: it proves things about the
    // spellings it recognises and says nothing about the rest, so `if (flags.wipe !== undefined)`
    // or `const w = flags.wipe; if (w)` reintroduces the exact coercion trap while the guard stays
    // green. Making ambiguity FAIL forces the author to declare intent in a recognised form.
    ...[...seen].filter(name => !booleans.has(name) && !values.has(name)).map(name => `unclassified read: ${name}`),
  ];
}
const cases = [
  {script:"admin",registry:ADMIN_BOOLEAN_FLAGS},
  {script:"brain-tasks",registry:TASK_BOOLEAN_FLAGS},
];
describe.each(cases)("AC8 $script registry", ({script,registry}) => {
  const source = readFileSync(`scripts/${script}.ts`,"utf8");
  it("covers every boolean consumer and excludes value consumers", () => {
    expect(violations(source,registry)).toEqual([]);
  });
  // KNOWN GAP, recorded rather than overclaimed (astra diff review). The forall clause is per
  // NAME, not per OCCURRENCE: one classified read blesses every other read of the same name, so a
  // name proven to be a value flag can still be truthiness-gated in an unrecognised spelling. Going
  // per-occurrence would require every `flags.x !== undefined` and every plain assignment across
  // both CLIs (~20 reads, none related to flag arity) to be rewritten into a recognised form, which
  // is disproportionate for this slice. `it.fails` so this flips RED the day someone closes it.
  it.fails("KNOWN GAP: a value-classified name can still be truthiness-gated elsewhere", () => {
    const mixed = 'typeof flags.wipe === "string";\nconst w = flags.wipe;\nif (w) destroy();';
    // `not.toEqual([])` pins the PROPERTY (some violation is reported), not a message string —
    // a per-occurrence fix that reports under a different wording would otherwise leave this green.
    expect(violations(mixed, [])).not.toEqual([]);
  });

  it("negative control: a boolean-typed `as` cast cannot launder an unregistered flag", () => {
    for (const read of [
      "const w = flags.wipe as boolean; if (w) go();",
      "flags.wipe as true;",
      // the spellings that defeated the two earlier attempts at this rule:
      "const w = flags.wipe as boolean | undefined; if (w) go();",
      "const w = flags.wipe as true | false; if (w) go();",
    ]) {
      expect(violations(read, []), read).toContain("unregistered boolean: wipe");
    }
    // A cast that declares NO intent must fail closed — not be treated as a value declaration.
    for (const read of [
      "const w = flags.wipe as any; if (w) go();",
      "const w = flags.wipe as unknown; if (w) go();",
      "const w = flags.wipe as unknown as boolean; if (w) go();",
      "const w = flags.wipe as Flag; if (w) go();",
    ]) {
      expect(violations(read, []), read).not.toEqual([]);
    }
    // …and the two real mixed/value unions stay VALUE reads, which is the boundary the rule must
    // respect: classifying these as boolean would redden both real CLIs.
    expect(violations('flags.tier as "team" | "external";', [])).toEqual([]);
    expect(violations("flags.labels as string | boolean | undefined;", [])).toEqual([]);
  });

  it("negative control: an UNCLASSIFIED read fails — the spellings that defeated the existential form", () => {
    // Each of these reintroduces the coercion trap while being invisible to every truthiness rule:
    // `--wipe false` makes the string "false", which is !== undefined and truthy.
    for (const read of [
      "if (flags.wipe !== undefined) doSomething();",
      "const w = flags.wipe; if (w) doSomething();",
      "doSomething(flags.wipe ?? false);",
      "const w = flags.wipe || false;",
    ]) {
      expect(violations(read, []), read).toContain("unclassified read: wipe");
    }
    // …and a name declared in a recognised class is NOT reported.
    expect(violations('typeof flags.wipe === "string";', [])).toEqual([]);
  });

  it("negative control: a new flags.newflag && read fails the same guard", () => {
    expect(violations(`${source}\nflags.newflag && doSomething();`,registry)).toContain("unregistered boolean: newflag");
  });
});
it("recognizes each required truthiness spelling and rejects mixed classes", () => {
  for (const read of ["Boolean(flags.newflag)","!flags.newflag","flags.newflag && work()","if (flags.newflag) work()",'if (flags["newflag"]) work()']) {
    expect(violations(read,[])).toContain("unregistered boolean: newflag");
  }
  expect(violations('if (flags.x) work(); flags.x as string;', ["x"])).toEqual(["registered value: x","both classes: x"]);
  expect(violations('typeof flags.x === "string"', ["x"])).toEqual(["registered value: x"]);
});
it("materialize confirmation keys are a subset of the admin registry", () => {
  // CONFIRM_KEYS is private and its file is comment-only in this spec's scope.
  // Read its declaration rather than maintain a second list; the exported defense is imported above.
  const source = ts.createSourceFile("materialize.ts",readFileSync("lib/access/materialize-command.ts","utf8"),ts.ScriptTarget.Latest,true);
  let keys: string[] | undefined;
  const seen = new Set<string>();
  const visit = (node: ts.Node) => {
    const anyName = flagName(node);
    if (anyName) seen.add(anyName);
    if (ts.isVariableDeclaration(node) && node.name.getText() === "CONFIRM_KEYS" && node.initializer) {
      const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      expect(ts.isArrayLiteralExpression(initializer)).toBe(true);
      if (ts.isArrayLiteralExpression(initializer)) keys = initializer.elements.map(element => {
        if (!ts.isStringLiteral(element)) throw new Error("CONFIRM_KEYS must contain literal names");
        return element.text;
      });
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  expect(keys?.length).toBeGreaterThan(0);
  for (const key of keys ?? []) {
    expect(ADMIN_BOOLEAN_FLAGS).toContain(key);
    expect(parseConfirmFlags({[key]:"false"}).ok).toBe(false);
  }
});
