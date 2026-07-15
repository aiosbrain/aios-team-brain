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
 * POST) appears anywhere outside the three sanctioned transport modules.
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
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (ALLOWLIST.has(rel)) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const src = readFileSync(file, "utf8");
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
