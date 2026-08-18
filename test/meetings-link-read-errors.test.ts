import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db/types";
import { linkMeetingNotesByIdentity } from "@/lib/meetings/link-notes";

/**
 * Spec (MTGATT-3 §2.3): a read that FAILS must never be read as "there was nothing there".
 *
 * WHY THIS FILE EXISTS AT ALL. The pg adapter RETURNS errors rather than throwing
 * (`lib/db/pg/query-builder.ts` catches and returns `{data: null, error}`), so the first version of
 * the linker — which destructured only `data` — turned a transient DB failure into: attendees `[]`
 * → `addMeetingNoteAttendees` no-ops → `setMeetingNoteMergedInto` succeeds → **the note is hidden
 * with its credit never transferred, permanently**, because the next tick excludes `merged_into`
 * notes. A failed BODY read was worse: every candidate reads as bodyless, so a transcript could be
 * folded behind a blank invite.
 *
 * A real DB cannot be made to fail one specific SELECT on demand, so this is a stub — the failure is
 * in the ADAPTER CONTRACT, not in Postgres, and the contract is what is pinned here.
 */

type Result = { data: unknown; error: { message: string } | null };

/** The chain shape `link-notes.ts` uses: from().select().eq().is().order().limit() / .in(), awaited. */
function stubDb(resultFor: (table: string) => Result, writes: string[]): DbClient {
  const chain = (table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order", "limit", "in", "maybeSingle", "single"]) {
      self[method] = () => self;
    }
    for (const method of ["update", "upsert", "insert", "delete"]) {
      self[method] = () => {
        writes.push(`${table}.${method}`);
        return self;
      };
    }
    self.then = (resolve: (v: Result) => unknown) => resolve(resultFor(table));
    return self;
  };
  return { from: (table: string) => chain(table) } as unknown as DbClient;
}

const NOTES = [
  { id: "tx", source_item_id: "i-tx", occurred_at: "2026-08-11", created_at: "2026-08-11T09:00:00.000Z" },
  { id: "cal", source_item_id: "i-cal", occurred_at: "2026-08-11", created_at: "2026-08-11T10:00:00.000Z" },
];
const FRONTMATTER = [
  { id: "i-tx", frontmatter: { calendar_event_id: "evt12345" } },
  { id: "i-cal", frontmatter: { calendar_event_id: "evt12345" } },
];
const BODIES = [
  { id: "i-tx", body: "# Design review\n\nWe agreed the rollout." },
  { id: "i-cal", body: "" },
];

/** Everything succeeds unless `failing` names the table (and `bodies` distinguishes the two item reads). */
function results(failing: string | null, bodyCallSeen: { n: number }) {
  return (table: string): Result => {
    if (table === failing) return { data: null, error: { message: "connection terminated" } };
    if (table === "meeting_notes") return { data: NOTES, error: null };
    if (table === "items") {
      // The module reads `items` twice: frontmatter first, then bodies for the keyed subset.
      bodyCallSeen.n += 1;
      return { data: bodyCallSeen.n === 1 ? FRONTMATTER : BODIES, error: null };
    }
    return { data: [], error: null };
  };
}

describe("linkMeetingNotesByIdentity — a failed read hides nothing", () => {
  it("links normally when every read succeeds (the control)", async () => {
    // Without this, every assertion below would pass on a stub that simply never links.
    const writes: string[] = [];
    const summary = await linkMeetingNotesByIdentity(stubDb(results(null, { n: 0 }), writes), "team-1");
    expect(summary.linked, "the control must actually link").toBe(1);
    expect(writes, "and must actually hide the folded note").toContain("meeting_notes.update");
  });

  for (const table of ["meeting_notes", "items", "meeting_note_attendees", "meeting_note_submitters"]) {
    it(`refuses to hide anything when the ${table} read fails`, async () => {
      const writes: string[] = [];
      const summary = await linkMeetingNotesByIdentity(stubDb(results(table, { n: 0 }), writes), "team-1");
      expect(summary.linked, "nothing may be counted as linked").toBe(0);
      expect(writes, "nothing may be hidden — the next tick retries").not.toContain("meeting_notes.update");
    });
  }
});
