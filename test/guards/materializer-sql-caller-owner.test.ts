import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PgClient } from "@/lib/db/pg/client";
import type { SqlExecutor } from "@/lib/db/types";

/**
 * STAGINGMARK-5 / AIO-1132 AC-03 — the frozen SQL materializer has ONE runtime caller.
 * Spec v2.2 "Service-owned transaction design" step 5.
 *
 * `materialize_builtin_membership_once()` stamps the PRET-4 completion marker. Boot, the scheduler
 * tick and the confirmed CLI must all reach it through `materializeBuiltinMembershipOnce`
 * (lib/access/groups.ts), which owns the bounded transaction around it: READ COMMITTED, the local
 * 120s/2s caps, exactly-one-boolean validation and the unknown-COMMIT report. A bare call anywhere
 * else would skip all of that while still stamping the marker. test/guards/access-bootstrap-callsites
 * pins that boot and tick call the SERVICE; it cannot see a bare SQL call placed beside it.
 *
 * Scanned: every repo-root source file (instrumentation.ts included) plus everything under lib/,
 * app/, scripts/ and docker/ with a TS/TSX/JS/MJS/CJS extension, with comments stripped. The
 * function's NAME may occur only in the owning service: exactly one invocation through the owned
 * session, plus its malformed-result diagnostic text. No file is exempt besides that owner — the
 * loaders included.
 *
 * Sanctioned separate surfaces, pinned explicitly below rather than exempted: the canonical
 * postgres/schema.sql definition and the PRET-6 migration's call (SQL, not scanned here, and
 * already pinned by access-single-writer), scripts/pg-load-schema.mjs which LOADS those files, and
 * docker/bootstrap.mjs which runs that loader. Neither loader may embed a direct call itself.
 *
 * SCOPE, stated honestly: this is the bounded LITERAL regression guard the spec asks for, not a
 * whole-program alias proof. A name assembled at runtime ("materialize_" + "builtin…") passes it.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const TREES = ["lib", "app", "scripts", "docker"];
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|cjs)$/;
const OWNER = "lib/access/groups.ts";
const OWNER_FUNCTION = "export async function materializeBuiltinMembershipOnce(";
const FUNCTION_NAME = /materialize_builtin_membership_once/gi;
/** The one owned invocation: the exact statement, sent through the owned transaction session. */
const OWNED_INVOCATION =
  /session\.executeSql\s*(?:<[^>]*>)?\s*\(\s*(["'`])SELECT materialize_builtin_membership_once\(\) AS result\1\s*\)/g;
/** The service's own malformed-result message names the function; it is text, not a call. */
const OWNED_DIAGNOSTIC = /`materialize_builtin_membership_once\(\) returned a malformed result/g;

const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Replace every JS/TS comment with spaces (newlines kept, so line numbers survive) while leaving
 * string, template and regex literal text intact: a commented-out mention is not a caller, and a
 * `//` or `/*` INSIDE a literal cannot hide the code that follows it. Lexical, not a parser — `//`
 * in JSX text or an unusual regex-vs-division context can still mis-scan; such a mis-scan can only
 * hide code on that line, and the controls below pin the literal shapes that matter.
 */
function stripComments(source: string): string {
  let out = "";
  // A code frame counts its open braces; one opened by `${` returns to its template at its own `}`.
  const stack: ({ mode: "code"; braces: number } | { mode: "template" })[] = [{ mode: "code", braces: 0 }];
  let prev = "";
  let word = "";
  let inWord = false;
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const top = stack[stack.length - 1];
    const c = source[i];
    if (top.mode === "template") {
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        stack.pop();
        out += c;
        i += 1;
        prev = c;
        inWord = false;
      } else if (c === "$" && source[i + 1] === "{") {
        stack.push({ mode: "code", braces: 0 });
        out += "${";
        i += 2;
        prev = "{";
        inWord = false;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, source.length);
      out += source.slice(i, j);
      i = j;
      prev = c;
      inWord = false;
      continue;
    }
    if (c === "`") {
      stack.push({ mode: "template" });
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_AFTER.includes(prev) || (/[\w$]/.test(prev) && REGEX_AFTER_WORD.has(word)))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        const d = source[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j += 1;
      }
      j = Math.min(j + 1, source.length);
      out += source.slice(i, j);
      i = j;
      prev = "/";
      inWord = false;
      continue;
    }
    if (c === "}" && top.braces === 0 && stack.length > 1) {
      stack.pop();
      out += c;
      i += 1;
      continue;
    }
    if (c === "{") top.braces += 1;
    if (c === "}") top.braces -= 1;
    out += c;
    i += 1;
    if (/[\w$]/.test(c)) {
      word = inWord ? word + c : c;
      inWord = true;
      prev = c;
    } else {
      inWord = false;
      if (!/\s/.test(c)) {
        word = "";
        prev = c;
      }
    }
  }
  return out;
}

const lineOf = (code: string, index: number) => code.slice(0, index).split("\n").length;
const nameHits = (code: string) => [...code.matchAll(FUNCTION_NAME)].map((m) => m.index ?? -1);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_FILE.test(name)) out.push(p);
  }
  return out;
}

/** The scanned surface: repo-root source files and the four runtime trees, keyed by POSIX relative path. */
function runtimeSources(): Map<string, string> {
  const files = new Map<string, string>();
  const add = (abs: string) => files.set(relative(ROOT, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
  for (const name of readdirSync(ROOT)) {
    const abs = join(ROOT, name);
    if (SOURCE_FILE.test(name) && statSync(abs).isFile()) add(abs);
  }
  for (const tree of TREES) for (const abs of walk(join(ROOT, tree))) add(abs);
  return files;
}

/** Every reason the owner file is not exactly "one owned invocation (+ its diagnostic) inside the service". */
function ownerOffences(source: string): string[] {
  const code = stripComments(source);
  const start = code.indexOf(OWNER_FUNCTION);
  if (start === -1) return [`${OWNER}: the owning service materializeBuiltinMembershipOnce is missing`];
  const nextExport = code.indexOf("\nexport ", start + OWNER_FUNCTION.length);
  const end = nextExport === -1 ? code.length : nextExport;
  const body = code.slice(start, end);
  const offences: string[] = [];
  for (const at of nameHits(code)) {
    if (at < start || at >= end) offences.push(`${OWNER}:${lineOf(code, at)} names the materializer outside materializeBuiltinMembershipOnce`);
  }
  const invocations = [...body.matchAll(OWNED_INVOCATION)].length;
  const diagnostics = [...body.matchAll(OWNED_DIAGNOSTIC)].length;
  if (invocations !== 1) offences.push(`${OWNER}: expected exactly one owned session.executeSql invocation, found ${invocations}`);
  if (diagnostics > 1) offences.push(`${OWNER}: expected at most one malformed-result diagnostic, found ${diagnostics}`);
  const inBody = nameHits(body).length;
  if (inBody !== invocations + diagnostics) {
    offences.push(`${OWNER}: ${inBody} name occurrences inside the service; only the owned invocation and its diagnostic are allowed`);
  }
  return offences;
}

/** Every literal occurrence of the function name outside the owner, plus every owner-shape violation. */
function callerOffences(files: ReadonlyMap<string, string>): string[] {
  const offences: string[] = [];
  for (const [rel, source] of files) {
    if (rel === OWNER) continue;
    const code = stripComments(source);
    for (const at of nameHits(code)) offences.push(`${rel}:${lineOf(code, at)} names the materializer outside its owner`);
  }
  const owner = files.get(OWNER);
  offences.push(...(owner === undefined ? [`${OWNER}: missing from the scanned surface`] : ownerOffences(owner)));
  return offences;
}

const sources = runtimeSources();
const mutated = (rel: string, source: string) => new Map([...sources, [rel, source]]);

/** Insert `line` immediately after the first line containing `anchor`, asserting the anchor exists. */
function insertAfter(source: string, anchor: string, line: string): { text: string; line: number } {
  const lines = source.split("\n");
  const index = lines.findIndex((l) => l.includes(anchor));
  expect(index, `mutation anchor present: ${anchor}`).toBeGreaterThan(-1);
  lines.splice(index + 1, 0, line);
  return { text: lines.join("\n"), line: index + 2 };
}

describe("STAGINGMARK-5 AC-03 — the frozen SQL materializer has exactly one runtime caller", () => {
  it("the scanned surface is repo-root source (instrumentation.ts included) plus lib/app/scripts/docker in all five extensions, loaders included", () => {
    for (const rel of [
      "instrumentation.ts",
      OWNER,
      "lib/access/materialize-command.ts",
      "lib/ingest/scheduler.ts",
      "lib/db/pg/client.ts",
      "scripts/admin.ts",
      "scripts/pg-load-schema.mjs",
      "docker/bootstrap.mjs",
    ]) {
      expect(sources.has(rel), `${rel} is scanned`).toBe(true);
    }
    expect([...sources.keys()].some((rel) => rel.startsWith("app/"))).toBe(true);
    expect([...sources.keys()].every((rel) => SOURCE_FILE.test(rel) && !rel.includes("node_modules/") && !rel.startsWith("test/"))).toBe(true);
    for (const ext of ["ts", "tsx", "js", "mjs", "cjs"]) expect(SOURCE_FILE.test(`scripts/x.${ext}`), ext).toBe(true);
    for (const ext of ["sql", "md", "json", "sh"]) expect(SOURCE_FILE.test(`scripts/x.${ext}`), ext).toBe(false);
  });

  it("only lib/access/groups.ts names the function, inside the service, with exactly one owned invocation", () => {
    const offences = callerOffences(sources);
    expect(offences, `direct materializer callers:\n${offences.join("\n")}`).toEqual([]);
    // Non-vacuous: the owner really carries the invocation this guard protects.
    const body = stripComments(sources.get(OWNER)!);
    expect([...body.matchAll(OWNED_INVOCATION)]).toHaveLength(1);
  });

  it("the sanctioned surfaces stay what they are: canonical SQL defines it, PRET-6 calls it, the loader loads files, bootstrap runs the loader", () => {
    const schema = readFileSync(join(ROOT, "postgres/schema.sql"), "utf8");
    expect(schema).toMatch(/create\s+or\s+replace\s+function\s+materialize_builtin_membership_once\s*\(\s*\)/i);
    const migration = readFileSync(join(ROOT, "postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql"), "utf8");
    expect(migration.replace(/--[^\n]*/g, "")).toMatch(/perform\s+materialize_builtin_membership_once\s*\(\s*\)/i);

    const loader = stripComments(sources.get("scripts/pg-load-schema.mjs")!);
    expect(loader).toMatch(/readFile\(\s*path\.join\(\s*pgDir,\s*"schema\.sql"\s*\)/);
    expect(loader).toMatch(/path\.join\(\s*pgDir,\s*"migrations"\s*\)/);
    const bootstrap = stripComments(sources.get("docker/bootstrap.mjs")!);
    expect(bootstrap).toMatch(/run\(\s*"node",\s*\[\s*"scripts\/pg-load-schema\.mjs"\s*\]\s*\)/);
    // Delegation, not exemption: both are scanned like every other file and name nothing.
    expect(nameHits(loader)).toEqual([]);
    expect(nameHits(bootstrap)).toEqual([]);
  });

  describe("there is no public RPC path to it", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("the pg adapter refuses rpc('materialize_builtin_membership_once') and sends nothing", async () => {
      const sent: string[] = [];
      const executor: SqlExecutor = async <T>(text: string) => {
        sent.push(text);
        return { rows: [] as T[], rowCount: 0 };
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await new PgClient({ executor }).rpc("materialize_builtin_membership_once");
      expect(result).toEqual({ data: null, error: { message: 'pg-adapter: unsupported rpc "materialize_builtin_membership_once"' } });
      expect(sent).toEqual([]);
    });
  });

  describe("reactive controls: each mutation of the REAL tree must redden the guard", () => {
    it("a bare boot SQL caller beside the real service call in instrumentation.ts", () => {
      const original = sources.get("instrumentation.ts")!;
      const anchor = "const m = await materializeBuiltinMembershipOnce(adminClient());";
      const { text, line } = insertAfter(
        original,
        anchor,
        '    await (await import("@/lib/db/pg/pool")).runSql("select materialize_builtin_membership_once()", []);'
      );
      // Beside, not instead of: the service call the callsite guard pins is still there.
      expect(stripComments(text)).toContain(anchor);
      expect(callerOffences(mutated("instrumentation.ts", text))).toEqual([`instrumentation.ts:${line} names the materializer outside its owner`]);
    });

    it("direct JS/MJS/CJS callers under scripts/ and docker/", () => {
      const callers: [string, string][] = [
        ["scripts/sm5-direct.mjs", 'import pg from "pg";\nconst c = new pg.Client();\nawait c.connect();\nawait c.query("select materialize_builtin_membership_once()");\n'],
        ["scripts/sm5-direct.cjs", "const { Pool } = require('pg');\nnew Pool().query('SELECT public.materialize_builtin_membership_once()');\n"],
        ["docker/sm5-direct.js", "export const run = (sql) => sql`select * from materialize_builtin_membership_once()`;\n"],
      ];
      for (const [rel, source] of callers) {
        expect(callerOffences(mutated(rel, source)), rel).toEqual([`${rel}:${source.split("\n").findIndex((l) => /materialize_builtin/.test(l)) + 1} names the materializer outside its owner`]);
      }
    });

    it("a direct call embedded in either existing loader — delegation is not a blanket exemption", () => {
      for (const rel of ["scripts/pg-load-schema.mjs", "docker/bootstrap.mjs"]) {
        const text = `${sources.get(rel)!}\nawait client.query("perform materialize_builtin_membership_once()");\n`;
        expect(callerOffences(mutated(rel, text)), rel).toEqual([`${rel}:${text.split("\n").length - 1} names the materializer outside its owner`]);
      }
    });

    it("an rpc-by-name caller elsewhere in lib/", () => {
      const rel = "lib/access/materialize-command.ts";
      const text = `${sources.get(rel)!}\nexport const bare = (db: { rpc: (fn: string) => unknown }) => db.rpc("materialize_builtin_membership_once");\n`;
      expect(callerOffences(mutated(rel, text))).toEqual([`${rel}:${text.split("\n").length - 1} names the materializer outside its owner`]);
    });

    it("the owner itself: a second invocation, a call outside the service, or a missing invocation", () => {
      const original = sources.get(OWNER)!;
      const invocation = '"SELECT materialize_builtin_membership_once() AS result"';
      expect(original).toContain(invocation);

      const second = insertAfter(original, "await session.executeSql(\"SELECT set_config('lock_timeout'", `      await session.executeSql(${invocation});`);
      expect(ownerOffences(second.text)).toEqual([
        `${OWNER}: expected exactly one owned session.executeSql invocation, found 2`,
      ]);

      const outside = `${original}\nexport const bare = (db: { rpc: (fn: string) => unknown }) => db.rpc("materialize_builtin_membership_once");\n`;
      expect(ownerOffences(outside)).toEqual([`${OWNER}:${outside.split("\n").length - 1} names the materializer outside materializeBuiltinMembershipOnce`]);

      const viaPool = original.replace(`session.executeSql<{ result?: unknown }>(\n        ${invocation}`, `runSql<{ result?: unknown }>(\n        ${invocation}`);
      expect(viaPool).not.toBe(original);
      expect(ownerOffences(viaPool)).toEqual([
        `${OWNER}: expected exactly one owned session.executeSql invocation, found 0`,
        `${OWNER}: 2 name occurrences inside the service; only the owned invocation and its diagnostic are allowed`,
      ]);
    });

    it("comments never count, but a `//` or `/*` inside a literal never hides the call after it", () => {
      const rel = "instrumentation.ts";
      const original = sources.get(rel)!;
      const commented = `${original}\n// await runSql("select materialize_builtin_membership_once()");\n/* materialize_builtin_membership_once() */\n`;
      expect(callerOffences(mutated(rel, commented))).toEqual([]);
      const inTemplate = `${original}\nconst t = \`x \${/* materialize_builtin_membership_once */ 1} y\`;\n`;
      expect(callerOffences(mutated(rel, inTemplate))).toEqual([]);

      const hiding = [
        'const url = "http://example.test"; await runSql("select materialize_builtin_membership_once()");',
        'const open = "/*"; await runSql("select materialize_builtin_membership_once()"); const close = "*/";',
        'const re = /\\/\\//; await runSql("select materialize_builtin_membership_once()");',
        "const q = `see http://example.test ${1} select materialize_builtin_membership_once()`;",
      ];
      for (const line of hiding) {
        const text = `${original}\n${line}\n`;
        expect(callerOffences(mutated(rel, text)), line).toEqual([`${rel}:${text.split("\n").length - 1} names the materializer outside its owner`]);
      }
    });
  });
});
