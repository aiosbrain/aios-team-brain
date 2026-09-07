import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * STGENV-4 — the whole-graph wipe must not be reachable from our code.
 * Spec: docs/design/staging-graph-reset.md.
 *
 * WHY THIS EXISTS, and why it is not ceremony. The self-hosted Graphiti sidecar ships upstream's
 * `POST /clear` (`test/fixtures/graphiti/ingest.py:105`), which is `clear_data(driver)` — the WHOLE
 * graph, every group, index rebuild. The sidecar has **no auth**: our client sends no `Authorization`
 * header, and the byte-identical secret people think of (`NEO4J_AUTH`) is Neo4j's, not the REST
 * server's. `GRAPHITI_URL` is in the app's environment. So on production, today, a graph wipe is one
 * `fetch` away from any module in the binary.
 *
 * Nothing calls it, and this pins that. Two review rounds spent themselves designing a *scoped*
 * deletion with identity conditions while this unscoped door stood open beside it — the guard that
 * mattered was the one for the door that already existed.
 *
 * PROSE IS NOT A CALL. `/clear` appears in `lib/metrics/individual-maturity.ts` describing the Claude
 * Code slash command, so a bare substring ban reddens on an honest tree — the shape that gets a guard
 * disabled. The rule is the PATH, not the caller: see `CLEAR_PATH` below for why enumerating call
 * shapes was tried, evaded, and abandoned.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Everything that runs in the production binary or beside it. The first version scanned `lib/` and
 * `scripts/` while its own rationale argued from "the production binary" — `app/` route handlers and
 * server actions are in that binary too, and one of them already builds a `GraphitiClient`.
 */
const SCANNED = ["lib", "scripts", "app", "components", "docker"] as const;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * ONE rule, not a list of call shapes: **a string whose path ENDS at `/clear`**.
 *
 * The first version enumerated verbs (`fetch|request|post|…`) and was evaded in seconds by
 * `this.post<void>("/clear", {})` — a generic parameter between the name and the paren. Enumerating
 * the ways a request can be spelled is a losing game; the constant is the path itself. Whatever
 * receives it, a `/clear` path literal anywhere in the shipped binary is the thing we are banning.
 *
 * It does NOT match prose, because prose keeps going: `"curate a CLAUDE.md and /clear between tasks"`
 * has `/clear` followed by a space, not by the closing quote. And it does not match `/clear-cache`.
 * Comments are stripped first, so a comment naming the endpoint is free.
 */
export const CLEAR_PATH = new RegExp(
  // ...the path segment `/clear`, then ONLY things that still reach POST /clear: a trailing slash
  // (Starlette answers 307 and fetch follows it preserving POST — a real wipe), a fragment, query
  // string, trailing whitespace the URL parser strips, or a template expression. The first version
  // required the closing quote immediately after `/clear`, and every one of these evaded it.
  // The Graphiti endpoint is the ROOT path of a base URL — `"/clear"`, `` `${base}/clear` ``,
  // `"$GRAPHITI_URL/clear"`, or a full URL. An APPLICATION route that merely ends at /clear
  // (`"/api/notifications/clear"`) is ordinary product surface and must not redden the build, so no
  // `/` may appear between the opening quote and the path — except the scheme's own, in a full URL.
  "[\"'`](?:https?:\\/\\/[^\\/\"'`\\n]*)?(?:\\$\\{[^}\\n]*\\}|[^\"'`\\n\\/])*\\/clear(?![\\w-])[\\/#?\\s]*(?:\\?[^\"'`\\n]*)?(?:\\$\\{[^}\\n]*\\})?[\"'`]",
  // Case-insensitive: Node's URL parser lowercases the scheme, so `HTTP://…/clear` is a real
  // request. `/CLEAR` is a 404 on Starlette, so banning it too costs nothing.
  "i"
);
/**
 * The UNQUOTED shell form — `curl -X POST $GRAPHITI_URL/clear` — which has no string literal for
 * `CLEAR_PATH` to anchor on. The quoted form is already caught by the path rule; this branch exists
 * only for the unquoted one, and has its own fixture so it is not silently dead (it was: the review
 * found the quoted fixture was killing the mutation via `CLEAR_PATH`, so deleting this branch
 * reddened nothing).
 */
export const CLEAR_SHELL = /\b(?:curl|wget)\b[^\n]*?[^\s"'`]\/clear(?![\w-])/i;

/**
 * Strip comments so PROSE about `/clear` is never a call — QUOTE-AWARE, because the first version
 * used `([^:"\`])\/\/.*$` and therefore stripped from any `//` not preceded by a quote, INCLUDING one
 * inside a string on the same line. `const s = "a // b"; await post("/clear")` disarmed the guard for
 * the rest of that line. A regex cannot know whether it is inside a string; a two-state scanner can.
 * `#` is a comment ONLY in shell files. Making it one everywhere — which the previous version did,
 * to cover `scripts/*.sh` — immediately created a new evasion in TypeScript: `this.#post("/clear")`,
 * an ES2022 private method, had the rest of its line eaten. That is the same class as the verb rule
 * this guard already learned once, introduced by the fix for a different finding.
 *
 * KNOWN LIMIT, stated rather than pretended away: this is a scanner, not a tokenizer. A regex literal
 * containing a quote (`/["']/`) or `/*` mis-syncs the state machine, which can suppress comment
 * stripping for the rest of the file. It never EATS a call — the failure direction is a false
 * positive on a later comment, not a false negative on a call.
 */
export function stripComments(source: string, ext = ".ts"): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === "\\") { out += source[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && source[i + 1] === "*" && ext !== ".sh") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 1; out += " "; continue; }
    // `#` is a shell comment; in JS/TS it is a private-name sigil, and treating it as a comment is
    // how `this.#post("/clear")` escapes. A shebang is column 0 of line 1 only.
    // In shell, `#` starts a comment only at word start — never inside `${VAR#pattern}`, which is
    // exactly the idiom that would appear in a wipe line. In JS it is a private-name sigil, so only
    // a column-0 shebang counts.
    const hashComment =
      c === "#" && (ext === ".sh" ? i === 0 || /\s/.test(source[i - 1]) : i === 0);
    // `//` is a comment in JS, NOT in shell — where it appears inside every `http://`. Treating it
    // as one in `.sh` ate the rest of the line, which is how `${GRAPHITI_URL#http://}/clear` slipped
    // through. Each language gets only its own comment syntax.
    const slashComment = c === "/" && source[i + 1] === "/" && ext !== ".sh";
    if (slashComment || hashComment) {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

export function callsClear(source: string, ext = ".ts"): boolean {
  const code = stripComments(source, ext);
  return CLEAR_PATH.test(code) || CLEAR_SHELL.test(code);
}

/**
 * The ONE sanctioned owner: the runbook's own script, which exists to make this exact call, from a
 * shell an operator opened on purpose. Everything else is the failure this guard is for. Same shape
 * as the repo's other single-owner rules — name the owner, ban the rest, and assert the owner is
 * still there so the exemption cannot outlive the file it exempts.
 */
export const CLEAR_OWNER = "scripts/staging-graph-clear.mjs";

describe("guard: the Graphiti whole-graph wipe is unreachable from our code (STGENV-4 C1)", () => {
  it("nothing in the shipped binary issues POST /clear, except the sanctioned owner", () => {
    const offenders = SCANNED.flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => callsClear(readFileSync(f, "utf8"), f.endsWith(".sh") ? ".sh" : ".ts"))
      .map((f) => f.slice(ROOT.length + 1));
    expect(
      offenders,
      "a whole-graph wipe must never be a code path except the runbook's own script — see docs/design/staging-graph-reset.md"
    ).toEqual([CLEAR_OWNER]);
  });

  it("C2: fires on the real shape and stays silent on prose", () => {
    // Non-vacuous in BOTH directions. A guard that matches nothing is ceremony; a guard that reddens
    // on an honest tree gets deleted. Both fixtures are asserted, so a mutation in either direction
    // is visible.
    // THE shape the review used to evade the first version of this guard — a generic parameter
    // between the method name and the paren. It is how this repo's own Graphiti client is written.
    expect(callsClear('await this.post<void>("/clear", {});')).toBe(true);
    expect(callsClear('const r = await this.request<unknown>("POST", "/clear");')).toBe(true);
    expect(callsClear('await fetch(`${this.baseUrl}/clear`, { method: "POST" });')).toBe(true);
    expect(callsClear('return this.request("POST", "/clear");')).toBe(true);
    expect(callsClear('const u = graphitiUrl + "/clear"; await fetch(u);')).toBe(true);
    expect(callsClear('const p = "/clear"; await fetch(base + p);')).toBe(true);
    // ...and the shell form, now that `scripts/*.sh` is scanned — the likeliest real home for it.
    expect(callsClear('curl -X POST "$GRAPHITI_URL/clear"')).toBe(true);
    // UNQUOTED shell: the only shape `CLEAR_PATH` cannot see, so this is what isolates CLEAR_SHELL.
    // Without it, deleting that branch reddens nothing — the review found exactly that.
    expect(callsClear("curl -X POST $GRAPHITI_URL/clear")).toBe(true);

    // Every one-character evasion the review found. `/clear/` is not cosmetic: Starlette answers a
    // trailing slash with 307 and fetch follows it PRESERVING POST, so it is a real wipe.
    expect(callsClear('await this.post<void>("/clear/", {});')).toBe(true);
    expect(callsClear('await this.post<void>("/clear#", {});')).toBe(true);
    expect(callsClear('await this.post<void>("/clear ", {});')).toBe(true);
    expect(callsClear('await fetch(`${base}/clear?force=1`);')).toBe(true);
    expect(callsClear('await fetch(`${base}/clear${qs}`);')).toBe(true);

    // A string containing ` // ` on the same line used to disarm the guard for the rest of the line,
    // because comment-stripping was a regex that could not tell it was inside a string.
    expect(callsClear('const s = "a // b"; await this.post<void>("/clear", {});')).toBe(true);
    // An ES2022 PRIVATE METHOD. Treating `#` as a comment everywhere — the fix for shell scripts —
    // ate the rest of this line. The repo has no `#private` members today, which is exactly why no
    // fixture caught it and why one exists now.
    expect(callsClear('await this.#post("/clear", {});')).toBe(true);
    // Uppercase scheme: Node lowercases it, so this is a real request.
    expect(callsClear('await fetch("HTTP://graphiti.railway.internal:8000/clear", { method: "POST" });')).toBe(true);
    // The shell `${VAR%/}` idiom puts a slash in the prefix; `#` inside `${VAR#pat}` is NOT a comment.
    expect(callsClear('u="${GRAPHITI_URL%/}/clear"; curl -X POST "$u"', ".sh")).toBe(true);
    expect(callsClear('curl -X POST ${GRAPHITI_URL#http://}/clear', ".sh")).toBe(true);
    // ...and the shell shebang is still a comment where it belongs.
    expect(callsClear('#!/usr/bin/env bash\ncurl -X POST $GRAPHITI_URL/clear', ".sh")).toBe(true);

    // ...and the prose that actually exists in this repo today.
    expect(callsClear('context_hygiene: "curate a CLAUDE.md and /clear between tasks";')).toBe(false);
    expect(callsClear("/** Remove a provider identity mapping (admins correcting/clearing a link). */")).toBe(false);
    expect(callsClear("// partial-write preserve/clear semantics")).toBe(false);
    // False positives the review found in the first version. A guard that reddens on honest code
    // gets disabled, so each is asserted rather than hoped for.
    expect(callsClear('// deliberately no post("/clear") here')).toBe(false);
    expect(callsClear('await fetch(`${base}/clear-cache`);')).toBe(false);
    // APPLICATION routes that merely END at /clear are ordinary product surface. The Graphiti
    // endpoint is the ROOT path of a base URL; a route with segments before it is not it. Whoever
    // ships a "clear notifications" feature should learn that from this test, not a red build.
    expect(callsClear('await fetch("/api/notifications/clear", { method: "POST" });')).toBe(false);
    expect(callsClear('<Link href="/settings/notifications/clear">Clear</Link>')).toBe(false);
    expect(callsClear('router.push("/dashboard/inbox/clear");')).toBe(false);
    // The column-0 shebang branch: pins that it does something, so a mutation dropping it reddens.
    expect(callsClear('#!/usr/bin/env node "/clear"\n')).toBe(false);
    // ...but a full URL to the sidecar's own root path is still caught.
    expect(callsClear('await fetch("http://graphiti.railway.internal:8000/clear", { method: "POST" });')).toBe(true);
    // NOTE: `forgot("/clear")` is deliberately NOT in this list. It IS a `/clear` path literal, and
    // banning it is correct — there is no legitimate reason for that string in `lib/` or `scripts/`.
    // Trying to decide which function may receive it is what let `this.post<void>` through.
  });

  it("the sanctioned owner exists, and nothing imports it", () => {
    // If the script is deleted, the exemption above silently becomes a hole. And the whole point of
    // it being a script is that no app code path reaches it: an import from `lib/` or `app/` would
    // put an unscoped wipe back into the running binary.
    expect(readFileSync(join(ROOT, CLEAR_OWNER), "utf8")).toContain("/clear");
    const importers = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))].filter((f) =>
      readFileSync(f, "utf8").includes("staging-graph-clear")
    );
    expect(importers, "the clear script must not be reachable from the app").toEqual([]);
  });

  it("the prose occurrence it must tolerate is still there — so the negative case is real, not hypothetical", () => {
    // If this file ever stops containing `/clear`, the tolerance fixture above is testing nothing that
    // exists, and the guard could be tightened to a substring ban without anyone noticing.
    const maturity = readFileSync(join(ROOT, "lib", "metrics", "individual-maturity.ts"), "utf8");
    expect(maturity).toContain("/clear");
  });
});

describe("guard: an agent cannot open a shell in a deployed container (STGENV-4 C3)", () => {
  it("`.claude/settings.json` denies `railway ssh`", () => {
    // The runbook's reset step is HUMAN-ONLY. Before this change the verb was in no list at all: the
    // hook classified it `allow · read-only` while the deny list refused it — two enforcement layers
    // disagreeing, which is the thing `test/railway-policy.test.ts` exists to prevent. Both now agree.
    // Without it an agent can open a write-capable shell inside a PRODUCTION container, where
    // `GRAPHITI_URL` and one request are all a wipe needs. Guard, not discipline (CLAUDE.md §2.2).
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8")) as {
      permissions?: { deny?: string[] };
    };
    const deny = settings.permissions?.deny ?? [];
    expect(deny).toContain("Bash(railway ssh)");
    expect(deny).toContain("Bash(railway ssh:*)");
    // The pre-existing deploy verbs must not have been traded away for it.
    for (const verb of ["up", "redeploy", "down", "delete"]) {
      expect(deny, `railway ${verb} must stay denied`).toContain(`Bash(railway ${verb}:*)`);
    }
  });
});

describe("guard: the runbook says what protects the operator (STGENV-4 C4, C5)", () => {
  const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
  const section = ops.slice(ops.indexOf("## 11. Staging refresh"));

  it("C4: OPS §11 documents the reset, its ORDER, the host check and the restart", () => {
    // Each clause asserted separately: an operator who loses any one of them loses a different
    // protection, so deleting any one must redden a different assertion.
    expect(section).toMatch(/Clearing staging's GRAPH after a refresh/i);
    expect(section).toContain("/clear");
    // The order, both directions — clearing early and clearing late fail differently.
    expect(section).toMatch(/Clearing \*before\* the refresh/i);
    expect(section).toMatch(/Clearing \*after\* re-projecting/i);
    // The host check IS the safety argument; a runbook that omits it is a runbook for a wipe.
    expect(section).toContain("railway.internal");
    expect(section).toMatch(/no authentication|has \*\*no authentication\*\*/i);
    // The restart, without which the reset is invisible for 48h.
    expect(section).toMatch(/[Rr]estart the staging app/);
    // Anchored to THIS section's own sentence, not a bare "48": OPS §11 already said "linger up to
    // 48h" before this change, so `toMatch(/48/)` was green before the restart step existed and
    // could never have failed. (Found in the pre-push review.)
    expect(section).toMatch(/keeps a non-empty prior for up to \*\*48 hours\*\*/);
    // The command must be ONE quoted argument — the defect that made the first version never fire.
    expect(section).toMatch(/ONE quoted argument/);
    expect(section).toContain("scripts/staging-graph-clear.mjs");
    expect(section).not.toMatch(/-- sh -c/);
  });

  it("C5: it does not claim the reset is automated or safe mid-extraction", () => {
    // The failure this prevents is a reader believing a manual step happens by itself.
    expect(section).toMatch(/\*\*not automated and not scheduled\*\*/i);
    expect(section).not.toMatch(/runs automatically after each refresh/i);
    expect(section).toMatch(/cannot be run safely while/i);
  });
});
