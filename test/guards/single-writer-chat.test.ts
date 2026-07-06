import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for chat history (CLAUDE.md §2). `conversations` and `chat_messages` are
 * owner-scoped — the access gate lives in app code, not RLS. The contract is that **only
 * `lib/chat/store` writes them**, so every write runs the `(team_id, member_id)` owner filter.
 * This test fails the build if any other file inserts/updates/deletes those tables, so a stray
 * write that skips the owner scope can't leak one member's chat to another. (Reads via `.select`
 * are not the concern — the store's readers are the gate; ad-hoc reads elsewhere would still need
 * owner scoping, but the write path is what this guard locks down.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "chat"); // the only legal writer lives here
const WRITE_RE = /from\(\s*["'](conversations|chat_messages)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      if (rel.startsWith(OWNER)) continue; // the sanctioned writer
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("${m[1]}").${m[2]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: conversations / chat_messages", () => {
  it("only lib/chat/store writes the chat tables", () => {
    const violations = offenders();
    expect(
      violations,
      `Only lib/chat/store may write conversations/chat_messages (owner-scoped). Offenders:\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    const W = () => new RegExp(WRITE_RE.source, "g");
    expect(W().test('await db.from("conversations").insert(rec)')).toBe(true);
    expect(W().test('db.from("chat_messages")\n  .update(x)')).toBe(true);
    expect(W().test('db.from("conversations").select("id").eq("team_id", t)')).toBe(false);
    expect(W().test('db.from("tasks").upsert(row)')).toBe(false);
  });
});
