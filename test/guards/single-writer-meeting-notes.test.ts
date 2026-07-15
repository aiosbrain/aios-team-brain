import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for `meeting_notes` / `meeting_note_attendees` (CLAUDE.md §2). They are
 * written ONLY by `lib/meetings/notes.ts`, which also writes the transcript through the existing
 * `lib/ingest.ingestItem` single writer and audits the create. This test fails the build if any
 * OTHER file inserts/updates/upserts/deletes them, so the single-writer contract is structural
 * rather than discipline. (Reads — select — are fine.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "meetings", "notes.ts");
const TABLES = ["meeting_notes", "meeting_note_attendees", "meeting_note_submitters"] as const;
const writeRe = (table: string) =>
  new RegExp(`from\\(\\s*["']${table}["']\\s*\\)\\s*\\.\\s*(insert|update|upsert|delete)\\b`, "g");

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
      if (rel === OWNER) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const table of TABLES) {
        for (const m of src.matchAll(writeRe(table))) hits.push(`${rel}: .from("${table}").${m[1]}(`);
      }
    }
  }
  return hits.sort();
}

describe("single-writer: meeting notes tables", () => {
  it("only lib/meetings/notes.ts writes meeting_notes / meeting_note_attendees", () => {
    const violations = offenders();
    expect(
      violations,
      `meeting-notes tables written outside lib/meetings/notes.ts (the audited single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates writes from reads (non-vacuity)", () => {
    expect(writeRe("meeting_notes").test('admin.from("meeting_notes").insert(')).toBe(true);
    expect(writeRe("meeting_note_attendees").test('admin.from("meeting_note_attendees").insert(')).toBe(true);
    expect(writeRe("meeting_notes").test('db.from("meeting_notes").select(')).toBe(false);
  });
});
