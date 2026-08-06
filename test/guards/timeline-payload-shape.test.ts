import { describe, expect, it } from "vitest";
import { PAYLOAD_VERSION } from "@/lib/dashboard/timeline-cache";
import { groupTimeline } from "@/lib/dashboard/timeline-group";

/**
 * BUILD-FAILING GUARD: the cached timeline payload's SHAPE is pinned to its version.
 *
 * `work_timeline_cache` is served stale-while-revalidate, so a row written by the previous build is
 * rendered by this one for a full TTL. `PAYLOAD_VERSION` is what makes that safe — a version the reader
 * doesn't recognise is treated as a miss. The mechanism only works if the version is bumped whenever
 * the shape changes, and that is a human step with nothing enforcing it.
 *
 * It has already failed once: the `other[]` → `unlinked` change was authored on v6→v7, then REBASED onto
 * a branch that had already taken 7 for its own shape change. Both shipped as v7, so prod served a
 * stale-shaped row as a fresh hit and rendered person-days with a name and an empty body.
 *
 * EVERY LEVEL, not just the top one. The guard used to pin `PersonDay`'s own keys and nothing below them,
 * so v10 — which added `TaskGroup.assignee` (whose task is this?) one level down — moved past it
 * untouched: its pinned key set was byte-identical to v9's. A nested field is exactly as capable of
 * making a stale row render wrongly as a top-level one (a v9 row has no `assignee`, so a teammate's
 * ticket renders as if it were yours), so the version has to be pinned against the WHOLE tree.
 *
 * Pinned against the JSON round-trip, because that is what's actually stored: `JSON.stringify` drops a
 * key whose value is `undefined`, so the in-memory object and the persisted row have different key sets.
 */

/** Every node type in the payload → the keys that version is allowed to carry. */
const SHAPE_BY_VERSION: Record<number, Record<string, string[]>> = {
  10: {
    // `summary` is attached on the cache-build path (`timeline-summary`), not by the pure builder, so
    // the fixture can't produce it — it is allowed but not required.
    personDay: ["memberId", "name", "handle", "avatarUrl", "summary", "total", "tasks", "other", "unlinked", "signals"],
    taskGroup: ["taskId", "title", "status", "source", "sources", "evidenceCount", "assignee"],
    assignee: ["name", "avatarUrl"],
    sourceGroup: ["source", "count", "items"],
    evidenceItem: ["id", "title", "url", "source", "kind", "at", "linkedTask", "linkVia"],
    signalGroup: ["kind", "count", "items"],
    signalItem: ["id", "kind", "title", "at", "url", "stillValid"],
  },
  // v11 is a MEANING-only bump (a Slack replier's evidence title no longer carries the thread root's
  // words) — the tree is byte-identical to v10, so the pin is copied deliberately, not forgotten.
  11: {
    personDay: ["memberId", "name", "handle", "avatarUrl", "summary", "total", "tasks", "other", "unlinked", "signals"],
    taskGroup: ["taskId", "title", "status", "source", "sources", "evidenceCount", "assignee"],
    assignee: ["name", "avatarUrl"],
    sourceGroup: ["source", "count", "items"],
    evidenceItem: ["id", "title", "url", "source", "kind", "at", "linkedTask", "linkVia"],
    signalGroup: ["kind", "count", "items"],
    signalItem: ["id", "kind", "title", "at", "url", "stillValid"],
  },
  // v12 adds `via` to evidenceItem — set only on a meeting credited to its SUBMITTER because no
  // attendee resolved. It is copied explicitly by the grouper, so it is exactly the kind of key that
  // gets silently dropped; the REQUIRED half below forces the fixture to actually produce one.
  12: {
    personDay: ["memberId", "name", "handle", "avatarUrl", "summary", "total", "tasks", "other", "unlinked", "signals"],
    taskGroup: ["taskId", "title", "status", "source", "sources", "evidenceCount", "assignee"],
    assignee: ["name", "avatarUrl"],
    sourceGroup: ["source", "count", "items"],
    evidenceItem: ["id", "title", "url", "source", "kind", "at", "linkedTask", "linkVia", "via"],
    signalGroup: ["kind", "count", "items"],
    signalItem: ["id", "kind", "title", "at", "url", "stillValid"],
  },
};

/**
 * Keys the FIXTURE below must actually produce, per node. This is the half that makes the guard
 * non-vacuous: "no unexpected key" alone passes just as happily when a field is DELETED, and deleting a
 * field a stale payload still carries is the same hazard as adding one.
 */
const REQUIRED_BY_VERSION: Record<number, Record<string, string[]>> = {
  10: {
    personDay: ["memberId", "name", "handle", "total", "tasks", "other", "unlinked", "signals"],
    taskGroup: ["taskId", "title", "status", "source", "sources", "evidenceCount", "assignee"],
    assignee: ["name", "avatarUrl"],
    sourceGroup: ["source", "count", "items"],
    evidenceItem: ["id", "title", "url", "source", "kind", "at", "linkVia"],
    signalGroup: ["kind", "count", "items"],
    signalItem: ["id", "kind", "title", "at", "url", "stillValid"],
  },
  // Copied from v10 — see the note on SHAPE_BY_VERSION[11].
  11: {
    personDay: ["memberId", "name", "handle", "total", "tasks", "other", "unlinked", "signals"],
    taskGroup: ["taskId", "title", "status", "source", "sources", "evidenceCount", "assignee"],
    assignee: ["name", "avatarUrl"],
    sourceGroup: ["source", "count", "items"],
    evidenceItem: ["id", "title", "url", "source", "kind", "at", "linkVia"],
    signalGroup: ["kind", "count", "items"],
    signalItem: ["id", "kind", "title", "at", "url", "stillValid"],
  },
  12: {
    personDay: ["memberId", "name", "handle", "total", "tasks", "other", "unlinked", "signals"],
    taskGroup: ["taskId", "title", "status", "source", "sources", "evidenceCount", "assignee"],
    assignee: ["name", "avatarUrl"],
    sourceGroup: ["source", "count", "items"],
    // `via` is REQUIRED of the fixture: "no unexpected key" alone would pass just as happily if the
    // grouper silently stopped copying it, which is the failure this version exists to pin.
    evidenceItem: ["id", "title", "url", "source", "kind", "at", "linkVia", "via"],
    signalGroup: ["kind", "count", "items"],
    signalItem: ["id", "kind", "title", "at", "url", "stillValid"],
  },
};

/** A day rich enough to instantiate every node type, including the OPTIONAL ones. */
function buildPayloadDays() {
  const at = "2026-07-22T09:00:00Z";
  return groupTimeline(
    [
      // m1 does the work; t1 belongs to m2 — that is what produces `TaskGroup.assignee`.
      { id: "e1", memberId: "m1", title: "commit one", url: "https://x/1", source: "github", kind: "commit", at, taskId: "t1", linkVia: "commit-text" },
      { id: "e2", memberId: "m1", title: "doc one", url: "https://x/2", source: "notion", kind: "doc", at, taskId: "t1", linkVia: "inferred" },
      // A MEETING credited to its submitter — the only producer of `via`, and the node the v12 bump
      // is about. Also the one evidence row that carries a bare date rather than a timestamp.
      { id: "n1:m1", memberId: "m1", title: "1-1 with Bob", url: "/t/acme/meetings/n1", source: "meetings", kind: "meeting", at: "2026-07-22", via: "submitter" as const },
      // …and one piece of work linked to nothing, so `other`/`unlinked` are populated too.
      { id: "e3", memberId: "m1", title: "stray file", url: "https://x/3", source: "github", kind: "file", at, linkVia: "pr" },
    ],
    new Map([["t1", { title: "Their ticket", status: "in_progress", source: "tasks", assigneeMemberId: "m2" }]]),
    new Map([
      ["m1", { name: "Alice", handle: "alice", avatarUrl: "https://a/1.png" }],
      ["m2", { name: "John", handle: "john", avatarUrl: "https://a/2.png" }],
    ]),
    "2026-07-22",
    undefined,
    [{ id: "d1", memberId: "m1", kind: "decision", title: "a decision", at: "2026-07-22", url: "/library/d1", stillValid: true }]
  );
}

/** Walk the payload and collect the keys observed at each node type. */
function observedKeys(days: unknown): Record<string, Set<string>> {
  const seen: Record<string, Set<string>> = {};
  const note = (node: string, obj: object) => {
    seen[node] ??= new Set();
    for (const k of Object.keys(obj)) seen[node].add(k);
  };
  type Day = { people?: unknown[] };
  for (const day of (days as Day[]) ?? []) {
    for (const p of (day.people ?? []) as Record<string, unknown>[]) {
      note("personDay", p);
      for (const t of (p.tasks ?? []) as Record<string, unknown>[]) {
        note("taskGroup", t);
        if (t.assignee) note("assignee", t.assignee as object);
        for (const g of (t.sources ?? []) as Record<string, unknown>[]) {
          note("sourceGroup", g);
          for (const it of (g.items ?? []) as object[]) note("evidenceItem", it);
        }
      }
      for (const g of (p.other ?? []) as Record<string, unknown>[]) {
        note("sourceGroup", g);
        for (const it of (g.items ?? []) as object[]) note("evidenceItem", it);
      }
      for (const g of (p.signals ?? []) as Record<string, unknown>[]) {
        note("signalGroup", g);
        for (const it of (g.items ?? []) as object[]) note("signalItem", it);
      }
    }
  }
  return seen;
}

describe("guard: the cached timeline payload shape matches its PAYLOAD_VERSION", () => {
  const allowed = SHAPE_BY_VERSION[PAYLOAD_VERSION];
  const required = REQUIRED_BY_VERSION[PAYLOAD_VERSION];

  it("has a pinned shape for the current version", () => {
    const hint =
      `PAYLOAD_VERSION is ${PAYLOAD_VERSION} but no shape is pinned for it. If you changed the payload — ` +
      `at ANY level, nested included — add its key sets here; if you bumped without a shape change, copy ` +
      `the previous entry.`;
    expect(allowed, hint).toBeDefined();
    expect(required, hint).toBeDefined();
  });

  it("every node in the payload carries exactly the keys this version promises", () => {
    // Round-trip: `JSON.stringify` drops undefined-valued keys, so this is the shape a cache row HAS.
    const seen = observedKeys(JSON.parse(JSON.stringify(buildPayloadDays())));

    for (const node of Object.keys(required)) {
      const actual = [...(seen[node] ?? [])].sort();
      expect(actual.length, `the fixture produced no ${node} — this guard would be vacuous for it`).toBeGreaterThan(0);
      expect(
        actual.filter((k) => !allowed[node].includes(k)),
        `unexpected key(s) on ${node} — a payload shape change, so bump PAYLOAD_VERSION and pin it here`
      ).toEqual([]);
      expect(
        required[node].filter((k) => !actual.includes(k)),
        `missing key(s) on ${node} — REMOVING a field is a shape change too: a stale row still carries it`
      ).toEqual([]);
    }
  });
});
