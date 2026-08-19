#!/usr/bin/env node
/**
 * Re-resolve attendance on EXISTING meeting notes from what the producer asserted (MTGATT-1/AIO-962).
 *
 * The fix in `lib/meetings/attendance.ts` only governs notes created from now on. The notes already
 * on the Meetings page carry the old inference, including the reported one: "Content creation
 * strategy session" (2026-08-11) lists Abe Isleem and Fatma, neither of whom attended, while its item
 * says `participants: "[John Ellison]"`.
 *
 * DRY RUN BY DEFAULT. This removes named people from meetings the owner has already read, so it
 * prints every change and writes nothing unless `--apply` is passed. A backfill that silently edits
 * attendance is indistinguishable from the bug it is fixing.
 *
 * IT ONLY ACTS WHERE THE PRODUCER ASSERTED SOMETHING. A note whose item has no `participants` keeps
 * whatever it has — there is no better answer available, and replacing an inference with an empty
 * list would delete real attendance to satisfy a rule. Calendar events are already exact and are
 * skipped entirely.
 *
 * Usage:
 *   DATABASE_URL=… node scripts/backfill-meeting-attendance.mjs            # report only
 *   DATABASE_URL=… node scripts/backfill-meeting-attendance.mjs --apply
 */
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

/** Mirrors `parseParticipantNames` in lib/meetings/attendance.ts — see the note at the bottom. */
function parseParticipantNames(raw) {
  const out = [];
  const push = (v) => {
    if (typeof v !== "string") return;
    const n = v.trim();
    if (n) out.push(n);
  };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === "string") push(e);
      else if (e && typeof e === "object") push(e.name ?? e.display ?? e.display_name ?? e.full_name);
    }
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
    for (const part of inner.split(",")) push(part);
  }
  const seen = new Set();
  return out.filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)));
}

/**
 * MUST mirror `normalizeName` in lib/meetings/llm-extract.ts EXACTLY, including the punctuation
 * strip. An earlier version here only lowercased and collapsed whitespace, which diverges on any
 * name carrying punctuation, and a real production value has exactly that shape: an
 * apostrophe-quoted nickname inside the name. `Daniel 'Dash' Okonkwo` is a PLACEHOLDER standing
 * in for it — the shape is the evidence, the person is not (this repo is public). A name that
 * resolves in the live path but not here would be DELETED by --apply: the script would "repair" an
 * attendee the product considers correct.
 */
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Mirrors `matchAsserted` in lib/meetings/attendance.ts — the STRICT rule, not `matchAttendees`.
 *
 * This must match the live path exactly or --apply deletes rows the product would keep (or keeps
 * rows it would delete). Strict because an asserted name is not a guess: first-name-only matching
 * would record `John Smith` as `John Ellison`, and this script WRITES that conclusion.
 */
function matchAsserted(names, roster) {
  const memberIds = [];
  const unresolved = [];
  const taken = new Set();
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const hits = roster.filter((p) => {
      const r = norm(p.display_name);
      return r === n || n.startsWith(r + " ") || r.startsWith(n + " ");
    });
    if (hits.length !== 1 || taken.has(hits[0].id)) {
      unresolved.push(raw);
      continue;
    }
    taken.add(hits[0].id);
    memberIds.push(hits[0].id);
  }
  return { memberIds, unresolved };
}

const db = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false } });
await db.connect();

const { rows: notes } = await db.query(`
  select n.id, n.team_id, n.title, n.occurred_at,
         i.frontmatter->'participants' as participants,
         i.frontmatter->>'source'      as source
  from meeting_notes n
  join items i on i.id = n.source_item_id
  where n.merged_into is null
  order by n.occurred_at desc nulls last`);

let considered = 0, changed = 0, unchanged = 0, skipped = 0;
const report = [];

for (const n of notes) {
  // Calendar events are already resolved exactly, by email. Nothing to improve.
  if (["calendar", "gcal", "google_calendar", "googlecalendar"].includes(n.source)) { skipped++; continue; }

  const names = parseParticipantNames(n.participants);
  if (names.length === 0) { skipped++; continue; } // nothing asserted — leave it alone
  considered++;

  const { rows: roster } = await db.query(
    `select id, display_name from members where team_id=$1 and status='active'`, [n.team_id]
  );
  const { memberIds: shouldIds, unresolved } = matchAsserted(names, roster);
  const should = new Set(shouldIds);

  const { rows: current } = await db.query(
    `select member_id from meeting_note_attendees where meeting_note_id=$1`, [n.id]
  );
  const have = new Set(current.map((r) => r.member_id));

  const add = [...should].filter((id) => !have.has(id));
  const remove = [...have].filter((id) => !should.has(id));
  if (add.length === 0 && remove.length === 0) { unchanged++; continue; }

  const nameOf = new Map(roster.map((r) => [r.id, r.display_name]));
  report.push({
    title: n.title,
    date: n.occurred_at,
    asserted: names.join(", "),
    unresolved,
    adding: add.map((id) => nameOf.get(id) ?? id),
    removing: remove.map((id) => nameOf.get(id) ?? id),
  });
  changed++;

  if (APPLY) {
    if (remove.length) {
      await db.query(`delete from meeting_note_attendees where meeting_note_id=$1 and member_id = any($2)`, [n.id, remove]);
    }
    for (const id of add) {
      await db.query(
        `insert into meeting_note_attendees (meeting_note_id, member_id) values ($1,$2) on conflict do nothing`,
        [n.id, id]
      );
    }
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN — nothing written"}\n`);
for (const r of report) {
  console.log(`  ${r.date}  ${r.title}`);
  console.log(`      producer asserted: ${r.asserted}`);
  if (r.removing.length) console.log(`      REMOVE: ${r.removing.join(", ")}`);
  if (r.adding.length) console.log(`      ADD:    ${r.adding.join(", ")}`);
  if (r.unresolved?.length) console.log(`      (not on this team, cannot be recorded: ${r.unresolved.join(", ")})`);
}
console.log(
  `\nconsidered ${considered} · changed ${changed} · already correct ${unchanged} · skipped (no assertion / calendar) ${skipped}`
);
if (!APPLY && changed > 0) console.log(`\nre-run with --apply to write these.`);
await db.end();

/*
 * WHY THE TWO HELPERS ARE COPIED RATHER THAN IMPORTED.
 *
 * `lib/meetings/attendance.ts` imports `matchAttendees` from `llm-extract.ts`, which pulls the LLM
 * client and `server-only` — neither loadable from a plain-node script. The alternative, running this
 * under `tsx --conditions react-server`, was rejected: this script performs DELETES against
 * production attendance, and a Next-flavoured module graph is a poor thing to have in that path.
 *
 * The duplication is real and is the cost. It is bounded by `test/meetings-attendance-source.test.ts`
 * covering the TS originals against prod's actual shapes, and by this script being a one-shot repair
 * rather than a live path — if the two ever diverge, the damage is a bad report, run in dry-run first
 * by default.
 */
