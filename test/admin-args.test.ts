import { describe, expect, it } from "vitest";
import { parseAdminArgs, ADMIN_BOOLEAN_FLAGS, TASK_BOOLEAN_FLAGS } from "@/lib/admin/args";
type Flags = Record<string, string | boolean>;
// AC6 compatibility oracle: verbatim HEAD tokenizer, replayed independently.
function parseArgs(argv: string[]): { cmd: string; positionals: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { cmd, positionals, flags };
}

const registries = [ADMIN_BOOLEAN_FLAGS, TASK_BOOLEAN_FLAGS];
describe.each(registries.map(registry => ({ registry })))("boolean arity $registry", ({ registry }) => {
  for (const name of registry) {
    it(`${name}: bare is true, omitted is absent, next flag survives`, () => {
      expect(parseAdminArgs(["help"], registry)).toEqual({ok:true, cmd:"help", positionals:[], flags:{}});
      for (const tail of [[], ["--team", "demo"]]) {
        const result = parseAdminArgs(["help", `--${name}`, ...tail], registry);
        expect(result).toEqual({ok:true, cmd:"help", positionals:[], flags:{[name]:true, ...(tail.length ? {team:"demo"}: {})}});
      }
    });
    for (const value of ["false", "true", "0", "yes", "", "-x", "extra", "hunter2"]) {
      for (const form of [[`--${name}`, value], [`--${name}=${value}`]]) {
        it(`${name}: refuses ${JSON.stringify(form)} before collapse`, () => {
          for (const tokens of [form, [...form, `--${name}`], [`--${name}`, ...form]]) {
            const result = parseAdminArgs(["help", ...tokens], registry);
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("accepted a value");
            expect(Object.keys(result).sort()).toEqual(["error", "ok"]);
            expect(result.error).toContain(`--${name}`);
            expect(result.error).toMatch(/takes no value.*bare/);
            expect(result.error).not.toContain("hunter2");
          }
        });
      }
    }
    it(`${name}: repeated bare succeeds`, () => {
      expect(parseAdminArgs(["help", `--${name}`, `--${name}`], registry)).toEqual({ok:true,cmd:"help",positionals:[],flags:{[name]:true}});
    });
  }
});
it("AC3 original collapse loses the malformed occurrence", () => {
  expect(parseArgs(["purge-items", "--confirm", "false", "--confirm"]).flags).toEqual({confirm:true});
});
it("AC4 keeps positionals before booleans", () => {
  expect(parseAdminArgs(["purge-items", "--confirm", "extra"], ADMIN_BOOLEAN_FLAGS).ok).toBe(false);
  expect(parseAdminArgs(["delete-member", "user@example.com", "--hard"], ADMIN_BOOLEAN_FLAGS)).toEqual({ok:true,cmd:"delete-member",positionals:["user@example.com"],flags:{hard:true}});
});
// Characterization is intentional ONLY here: pin every current command and value name.
const commands = ['create-team', 'create-member', 'login-link', 'issue-key', 'revoke-key', 'list-members', 'list-keys', 'delete-member', 'add-group-member', 'remove-group-member', 'grant-project', 'repair-system-edge', 'revoke-project', 'rename-team', 'add-author-alias', 'link-github', 'link-identity', 'access-health', 'drain-context', 'purge-items', 'materialize-builtins', 'sync-github', 'help', 'pg:schema', 'add', 'set', 'list', 'show', 'project', 'extract-meeting-todos', 'resolve', 'adopt'];
const values = ["team", "name", "handle", "role", "tier", "password", "base-url", "ttl-min", "actor", "email", "ids", "reason", "org", "project", "title", "row-key", "status", "priority", "labels", "parent", "sprint", "assignee", "body-file", "origin", "source-project", "path-prefix", "since", "limit", "filter", "resource-id", "url"];
it.each(commands)("AC6 HEAD compatibility: %s", (cmd) => {
  for (const name of values) for (const tail of [[], ["text"], [""], ["-x"], ["--other"], ["first", `--${name}`, "last"]]) {
    const argv = [cmd, "positional", `--${name}`, ...tail];
    for (const registry of registries) expect(parseAdminArgs(argv, registry)).toEqual({ok:true,...parseArgs(argv)});
    const equals = [cmd, `--${name}=text`];
    for (const registry of registries) expect(parseAdminArgs(equals, registry)).toEqual({ok:true,...parseArgs(equals)});
  }
});

describe("STAGINGMARK-4 — a LEADING boolean flag is validated too", () => {
  // The command token is at argv[0]; validating from index 1 let `admin --confirm false` through
  // to an unrelated error. A leading token is never a valid command, so it is validated as well.
  it("refuses a registered boolean in the command position when given a value", () => {
    const r = parseAdminArgs(["--confirm", "false"], ADMIN_BOOLEAN_FLAGS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/takes no value/);
  });
  it("still accepts a bare leading boolean", () => {
    expect(parseAdminArgs(["--help"], ADMIN_BOOLEAN_FLAGS).ok).toBe(true);
  });
});
