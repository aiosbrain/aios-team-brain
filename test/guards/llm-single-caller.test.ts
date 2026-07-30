import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * LLM-provider single-caller guard. Every LLM generation task must resolve its backend through
 * `selectLlmBackend` (via the shared `lib/llm/complete` primitive), so it honors the team's
 * answering-provider setting — including OpenRouter. This existed as a latent gap: `lib/graph/arcs`
 * and `lib/meetings/llm-extract` each had a bespoke `LLM_BASE_URL ? openai : anthropic` transport
 * that ignored `teams.answering_provider`, so a team on OpenRouter still got arcs/meetings from
 * OpenAI. This guard fails the build if raw LLM transport (`new Anthropic(` or a `/chat/completions`
 * POST) appears anywhere outside the sanctioned transport modules.
 *
 * Sanctioned (each MUST route through `selectLlmBackend`, asserted below):
 *   - lib/llm/complete.ts   — the shared non-streaming primitive every feature calls
 *   - lib/query/claude.ts   — the streaming answer path (can't use the non-streaming primitive)
 *   - lib/chat/title.ts     — the cheap-title path (own 6s timeout; still settings-aware)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const ALLOWLIST = new Set([
  join("lib", "llm", "complete.ts"),
  join("lib", "query", "claude.ts"),
  join("lib", "chat", "title.ts"),
  // The graph LLM proxy. Admitted for the OPPOSITE reason to a bypass: the Graphiti container cannot
  // read this database, so before it existed the graph ran on a second provider key that no setting
  // in this app governed — and that key silently ran out of quota. This module is what forces the
  // graph leg through the same console settings as everything else, and the assertion below still
  // holds it to resolving via `selectLlmBackend`.
  join("lib", "llm", "graph-proxy.ts"),
]);
const RAW_TRANSPORT = [/new\s+Anthropic\s*\(/, /chat\/completions/];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    // `.mjs` too: `scripts/` is now mostly .mjs (setup-wizard, setup/*, doctor, bootstrap), so a
    // TS-only walk left a growing blind spot where a raw `/chat/completions` POST would pass the
    // build. Traces to a real class of file, not ceremony.
    else if (/\.(ts|tsx|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Remove `//` line comments and block comments before matching.
 *
 * Not a parser, and the imprecision is bounded on purpose: it can blank a comment marker that lives
 * inside a STRING, which loses coverage (a miss) but never invents an accusation. A miss is the safe
 * direction for this guard — the cost is one uncaught call, not a red build someone "fixes" by
 * deleting a comment.
 *
 * The block opener requires a boundary before `/*` precisely to keep that bounded: without it, a
 * glob or cron string (`"app/*.ts"`, `"*\/5 * * * *"`) opens a phantom comment that swallows
 * everything up to the next `*\/` anywhere in the file — including real transport code. Those
 * strings occur by accident, not just adversarially.
 *
 * Still-known gaps, unchanged by this helper and pre-existing: a URL assembled from parts
 * (`base + "/chat/" + "completions"`) never matched the raw regex either, and a protocol-relative
 * `fetch("//host/v1/chat/completions")` has its `//` treated as a comment. Both are misses, both
 * were misses before comment-stripping existed.
 */
function stripComments(src: string): string {
  return src
    .replace(/(^|[\s(,;=:[{])\/\*[\s\S]*?\*\//g, "$1 ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (ALLOWLIST.has(rel)) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      // Strip comments before matching. Prose is not an invocation — the same distinction
      // `railway-policy.mjs` draws for its forbidden verbs. Without this, a file that DOCUMENTS
      // that it never posts to /chat/completions gets flagged for saying so, which teaches people
      // to delete the explanation rather than keep the guard honest.
      const src = stripComments(readFileSync(file, "utf8"));
      for (const re of RAW_TRANSPORT) {
        if (re.test(src)) hits.push(`${rel}: matches ${re}`);
      }
    }
  }
  return hits.sort();
}

describe("LLM provider single-caller", () => {
  it("raw LLM transport lives only in the sanctioned settings-aware modules", () => {
    const violations = offenders();
    expect(
      violations,
      `LLM transport outside the sanctioned modules — route it through lib/llm/complete (so it honors the answering-provider setting incl. OpenRouter):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("every sanctioned transport module resolves via selectLlmBackend (stays settings-aware)", () => {
    for (const rel of ALLOWLIST) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} must resolve its backend via selectLlmBackend`).toMatch(/selectLlmBackend/);
    }
  });

  it("the matcher is non-vacuous (would catch a bespoke caller)", () => {
    expect(RAW_TRANSPORT.some((re) => re.test('const c = new Anthropic({ apiKey })'))).toBe(true);
    expect(RAW_TRANSPORT.some((re) => re.test('fetch(`${base}/chat/completions`)'))).toBe(true);
    expect(RAW_TRANSPORT.some((re) => re.test('db.from("items").select("*")'))).toBe(false);
  });
});
