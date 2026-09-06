import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ADMIN_BOOLEAN_FLAGS, TASK_BOOLEAN_FLAGS } from "@/lib/admin/args";
import { parseConfirmFlags } from "@/lib/access/materialize-command";

function unwrap(node: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}
function flagName(node: ts.Node): string | undefined {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "flags") return node.name.text;
  if (ts.isElementAccessExpression(node) && node.expression.getText() === "flags" && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
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
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === "Boolean") node.arguments.forEach(arg => add(booleans, arg));
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) add(booleans, node.operand);
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) condition(node.expression);
    if (ts.isConditionalExpression(node)) condition(node.condition);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) add(booleans, node.left);
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.StringKeyword) add(values, node.expression);
    if (ts.isBinaryExpression(node)) {
      for (const [left,right] of [[node.left,node.right],[node.right,node.left]]) {
        if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right) && right.text === "string") add(values, left.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {booleans,values};
}
function violations(source: string, registry: readonly string[]) {
  const {booleans,values} = classify(source);
  return [
    ...[...booleans].filter(name => !registry.includes(name)).map(name => `unregistered boolean: ${name}`),
    ...[...values].filter(name => registry.includes(name)).map(name => `registered value: ${name}`),
    ...[...booleans].filter(name => values.has(name)).map(name => `both classes: ${name}`),
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
  const visit = (node: ts.Node) => {
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
