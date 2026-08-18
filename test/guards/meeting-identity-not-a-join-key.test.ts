import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: a conference link must never decide that two meetings are the same one (MTGATT-2).
 *
 * `eventIdentity` parses a normalised `conferenceKey` because it is worth MEASURING — how often would
 * a Meet/Zoom link have been the only shared signal between a calendar event and its transcript? It
 * must never be JOINED on, and the reason is not caution:
 *
 *   · a Zoom Personal Meeting ID (`zoom.us/j/1234567890`) is reused for every meeting that person
 *     hosts, so it groups a weekly staff meeting with an unrelated customer call;
 *   · one Google Meet room serves an entire recurring series, so it groups every instance.
 *
 * Both fuse UNRELATED meetings, which for this feature is the fatal direction: it would union two
 * meetings' attendance and put people in rooms they were never in — the MTGATT-1 failure, arriving
 * through the path we called exact.
 *
 * Pinned as source text because the property is an ABSENCE, and an absence has no runtime handle.
 * The allowed sites are the parser that produces the value and the read-only report that counts it.
 */
const ALLOWED = new Set(["lib/meetings/event-identity.ts", "scripts/meeting-pairing-report.ts"]);

/**
 * Code only — a guard that reads comments fires on its own documentation, and the first version of
 * this file did exactly that (the parser's header explains why it must not join on a title, and the
 * guard read that explanation as the violation). The line-comment pattern requires whitespace or a
 * line start before `//` so a `https://` inside a string is not mistaken for a comment, which would
 * truncate the line and could hide a real violation sitting after it.
 */
const codeOnly = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe("guard: the conference link is measured, never joined on", () => {
  it("no module outside the parser and the report references conferenceKey", () => {
    const offenders = [...filesUnder("lib"), ...filesUnder("scripts"), ...filesUnder("app")]
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /conferenceKey/.test(codeOnly(readFileSync(join(process.cwd(), rel), "utf8"))));
    expect(offenders, "a conference link must not reach a matching/grouping path").toEqual([]);
  });

  it("the parser itself does not group, match or dedupe — it only parses", () => {
    // The inverse half: the guard above would also pass if `event-identity.ts` grew the join itself,
    // since that file is on the allow-list. Pin what the allowed file is allowed to BE.
    const src = codeOnly(readFileSync(join(process.cwd(), "lib/meetings/event-identity.ts"), "utf8"));
    expect(src).not.toMatch(/from\s+"@\/lib\/db/);
    expect(src).not.toMatch(/\bmerged_into\b|\bfindDuplicate|\btitleSimilarity\b/);
  });

  it("the report is read-only — it must not write attendance or fold notes", () => {
    const src = codeOnly(readFileSync(join(process.cwd(), "scripts/meeting-pairing-report.ts"), "utf8"));
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(src, `the pairing report must not call ${forbidden}`).not.toContain(forbidden);
    }
  });
});
