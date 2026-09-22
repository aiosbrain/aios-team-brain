import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOTS = ["app", "lib", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const WATCHED_MEMBER_FIELDS = new Set(["email", "actor_handle", "status", "is_connector"]);

const EXPECTED = new Map<string, number>([
  ["lib/admin/aliases.ts", 3],
  ["lib/admin/members.ts", 5],
  ["lib/auth/pg-login.ts", 2],
  ["lib/identity/member-identities.ts", 4],
  ["lib/ingest/run.ts", 1],
  ["lib/integrations/gdrive-authority.ts", 1],
  ["scripts/seed-demo.ts", 1],
]);

function filesBelow(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) out.push(...filesBelow(full));
    else if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
  return out;
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function tableFromChain(node: ts.Expression): string | null {
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "from") {
      return literalText(node.arguments[0]);
    }
    if (ts.isPropertyAccessExpression(node.expression)) return tableFromChain(node.expression.expression);
  }
  if (ts.isPropertyAccessExpression(node)) return tableFromChain(node.expression);
  return null;
}

function objectKeys(node: ts.Expression | undefined): Set<string> {
  const keys = new Set<string>();
  if (!node || !ts.isObjectLiteralExpression(node)) return keys;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = property.name;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) keys.add(name.text);
  }
  return keys;
}

function sqlIsAuthorityMutation(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (/^(insert into|delete from) (public\.)?(members|member_emails|member_identities)\b/.test(normalized)) {
    return true;
  }
  if (/^update (public\.)?(member_emails|member_identities)\b/.test(normalized)) return true;
  const memberUpdate = normalized.match(/^update (public\.)?members set (.+?) where\b/);
  return Boolean(memberUpdate && [...WATCHED_MEMBER_FIELDS].some((field) =>
    new RegExp(`\\b${field}\\s*=`).test(memberUpdate[2])));
}

function countAuthorityMutations(source: string, file: string): number {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const operation = node.expression.name.text;
      if (["insert", "upsert", "update", "delete"].includes(operation)) {
        const table = tableFromChain(node.expression.expression);
        if (table === "member_emails" || table === "member_identities") count++;
        else if (table === "members" && operation !== "update") count++;
        else if (table === "members" && [...objectKeys(node.arguments[0])].some((key) => WATCHED_MEMBER_FIELDS.has(key))) count++;
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "runSql") {
      const sql = literalText(node.arguments[0]);
      if (sql && sqlIsAuthorityMutation(sql)) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

describe("identity mutation boundary source guard", () => {
  it("keeps every direct authority mutation in an audited boundary owner", () => {
    const actual = new Map<string, number>();
    for (const root of ROOTS) {
      for (const file of filesBelow(path.join(process.cwd(), root))) {
        const source = readFileSync(file, "utf8");
        const count = countAuthorityMutations(source, file);
        if (!count) continue;
        const relative = path.relative(process.cwd(), file);
        actual.set(relative, count);
        expect(
          source.includes("withIdentityMutationBoundary") || source.includes("lockIdentityMutationAuthorities"),
          `${relative} mutates identity authority without the shared boundary`,
        ).toBe(true);
      }
    }
    expect([...actual.entries()].sort()).toEqual([...EXPECTED.entries()].sort());
  });

  it("keeps the database trigger bookkeeping-only", () => {
    const schema = readFileSync(path.join(process.cwd(), "postgres/schema.sql"), "utf8");
    const body = schema.match(/create or replace function bump_team_identity_authority\(\)[\s\S]+?end \$\$;/)?.[0];
    expect(body).toBeTruthy();
    expect(body).not.toContain("pg_advisory_xact_lock");
    expect(body).toContain("team_identity_authority");
    expect(body).toContain("team_authorization_epochs");
  });
});
