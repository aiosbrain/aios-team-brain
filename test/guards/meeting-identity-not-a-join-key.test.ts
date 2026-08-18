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
 * The needles: the parsed key AND the raw frontmatter spellings it is parsed from. Grepping only for
 * `conferenceKey` left the obvious bypass open — a future join reading `fm.conference_url` or
 * `fm.hangoutLink` straight off the item would never touch the parser and would sail through.
 */
const NEEDLES = [/conferenceKey/, /conference_url/, /hangoutLink/, /hangout_link/, /meeting_url/, /conferenceUrl/];
// Every spelling `CONFERENCE_KEYS` in the parser accepts must appear above, or a join can read the
// raw field under a name the guard does not know. `meeting_url` and `conferenceUrl` were exactly
// that gap: accepted by the parser, invisible to the first version of this list.

/**
 * Comment lines, dropped LINE BY LINE rather than by stripping `/* … *\/` across the file.
 *
 * A guard that reads comments fires on its own documentation — the first version of this file did
 * exactly that. But the obvious fix (regex-strip block comments) is defeated by a STRING containing
 * `/*`, which would swallow real code up to the next `*\/` and hide a violation. Judging each line on
 * its own leading token cannot be turned off by anything written on another line. It over-reports on
 * a block comment whose continuation lines do not start with `*`, and that is the safe direction: a
 * false positive is a loud, fixable failure; a false negative is the leak this guard exists to stop.
 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
}

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
  it("no module outside the parser and the report touches a conference link, by any spelling", () => {
    const offenders = [...filesUnder("lib"), ...filesUnder("scripts"), ...filesUnder("app")]
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const code = codeOnly(readFileSync(join(process.cwd(), rel), "utf8"));
        return NEEDLES.some((n) => n.test(code));
      });
    expect(offenders, "a conference link must not reach a matching/grouping path").toEqual([]);
  });

  it("the needle list itself is non-vacuous — each pattern matches the text it is meant to catch", () => {
    // A guard whose needles match nothing passes forever. Every pattern is exercised against a line
    // that a real bypass would contain, so a typo in one of them reddens here instead of going quiet.
    const samples = [
      "const k = a.conferenceKey;",
      "fm.conference_url",
      "event.hangoutLink",
      "fm.hangout_link",
      "fm.meeting_url",
      "fm.conferenceUrl",
    ];
    for (const [i, n] of NEEDLES.entries()) expect(n.test(samples[i]), samples[i]).toBe(true);
  });

  it("every conference spelling the PARSER accepts is covered by a needle", () => {
    // The drift this closes: adding a key to CONFERENCE_KEYS without adding it here would silently
    // widen what the parser reads while narrowing what the guard watches.
    const parser = readFileSync(join(process.cwd(), "lib/meetings/event-identity.ts"), "utf8");
    const list = parser.match(/const CONFERENCE_KEYS = \[([^\]]+)\]/)?.[1] ?? "";
    const spellings = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(spellings.length, "the CONFERENCE_KEYS list must be readable").toBeGreaterThan(0);
    for (const s of spellings) {
      expect(NEEDLES.some((n) => n.test(s)), `no guard needle covers the accepted spelling "${s}"`).toBe(true);
    }
  });

  it("the comment filter cannot be switched off by a string containing a comment opener", () => {
    // The regex version of this stripper swallowed everything between a `/*` inside a string literal
    // and the next `*/`, hiding any violation in between.
    const sneaky = ['const s = "/*";', "joinMeetings(a.conferenceKey, b.conferenceKey);", 'const e = "*/";'].join("\n");
    expect(NEEDLES.some((n) => n.test(codeOnly(sneaky))), "a real join must remain visible").toBe(true);
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
