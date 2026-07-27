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
 * This test pins the key set against the version. Changing the shape turns it red, and the only way to
 * green it is to update BOTH — which is exactly the moment to bump.
 */

const SHAPE_BY_VERSION: Record<number, string[]> = {
  8: ["memberId", "name", "handle", "avatarUrl", "total", "tasks", "unlinked", "signals"],
};

describe("guard: the cached timeline payload shape matches its PAYLOAD_VERSION", () => {
  it("a PersonDay carries exactly the keys this version promises", () => {
    const expected = SHAPE_BY_VERSION[PAYLOAD_VERSION];
    expect(
      expected,
      `PAYLOAD_VERSION is ${PAYLOAD_VERSION} but no shape is pinned for it. If you changed the payload, ` +
        `add its key set here; if you bumped without a shape change, copy the previous entry.`
    ).toBeDefined();

    const days = groupTimeline(
      [{ id: "e1", memberId: "m1", title: "t", source: "github", kind: "commit", at: "2026-07-22T09:00:00Z", taskId: "t1" }],
      new Map([["t1", { title: "Task", status: "in_progress", source: "tasks" }]]),
      new Map([["m1", { name: "Alice", handle: "alice", avatarUrl: undefined }]]),
      "2026-07-22"
    );
    const person = days[0]?.people[0];
    expect(person, "the fixture must produce a person-day, or this guard is vacuous").toBeDefined();

    // `avatarUrl` is optional and absent here, so compare on the REQUIRED subset plus a check that no
    // unexpected key appeared — a new field is a shape change even when it is additive.
    const actual = Object.keys(person!).sort();
    const allowed = expected.slice().sort();
    expect(actual.filter((k) => !allowed.includes(k)), "unexpected key(s) — bump PAYLOAD_VERSION").toEqual([]);
    for (const required of ["tasks", "unlinked", "total", "signals"]) {
      expect(actual, `missing ${required}`).toContain(required);
    }
  });
});
