import { describe, expect, it } from "vitest";
import { decideReattribution } from "@/lib/ingest/reattribution-decision";

/**
 * Spec for re-attribution on an UNCHANGED re-push (a source reassigned an item without touching its
 * prose). Policy: propagate a source-driven owner change UNLESS locked; never auto-clear to null; a
 * null→member fill is a heal (not a reassignment). Pure, no DB. The `member_id_locked` guard (#333) is
 * what makes source-driven re-pointing safe.
 */

const A = "member-a";
const B = "member-b";

describe("decideReattribution", () => {
  it("re-points + reports the prior owner on a genuine source reassignment (A → B)", () => {
    expect(decideReattribution(A, B, false)).toEqual({ memberId: B, reassignedFrom: A });
  });

  it("fills an unattributed item without calling it a reassignment (null → member = a heal)", () => {
    expect(decideReattribution(null, B, false)).toEqual({ memberId: B });
  });

  it("does nothing when LOCKED — a deliberate correction is never reverted by a source re-push", () => {
    expect(decideReattribution(A, B, true)).toEqual({});
    expect(decideReattribution(null, B, true)).toEqual({}); // locked correct-to-nobody stays nobody
  });

  it("never auto-clears a set owner to nobody (a connector's unresolved push passes null)", () => {
    expect(decideReattribution(A, null, false)).toEqual({});
  });

  it("is a no-op when the resolved author already matches the current owner", () => {
    expect(decideReattribution(A, A, false)).toEqual({});
    expect(decideReattribution(null, null, false)).toEqual({});
  });
});
