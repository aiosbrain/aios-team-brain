import { describe, expect, it } from "vitest";
import { decideDedupeAlert } from "@/lib/graph/extraction-alert";

/**
 * The edge state machine that decides when the dedupe-pollution alarm mails an admin (AIO-693).
 *
 * Spec-first, from the alarm's contract: one mail on the ok→polluted edge, one on polluted→ok,
 * silence in between — and an UNJUDGEABLE tick (Neo4j unreadable / sample too small) moves the
 * machine in neither direction, because an alarm that "recovers" during an outage teaches admins to
 * ignore the recovery mail. Each row pins one transition; together they cover the full 2×2×judgeable
 * space, so flipping any comparison in `decideDedupeAlert` reddens at least one.
 */

const judged = (polluted: boolean) => ({ polluted, recentShare: 0.5, baselineShare: 0.3 });
// The detector can only emit `polluted: false` for an unjudgeable sample (its own contract), so the
// unjudgeable rows below never pair `polluted: true` with null shares.
const unjudgeable = { polluted: false, recentShare: null, baselineShare: null };

describe("decideDedupeAlert", () => {
  it("fires exactly on the ok→polluted edge", () => {
    expect(decideDedupeAlert(false, judged(true))).toBe("alert");
  });

  it("stays silent while pollution persists (no mail per tick)", () => {
    expect(decideDedupeAlert(true, judged(true))).toBe("none");
  });

  it("recovers exactly on the polluted→ok edge", () => {
    expect(decideDedupeAlert(true, judged(false))).toBe("recover");
  });

  it("stays silent while healthy", () => {
    expect(decideDedupeAlert(false, judged(false))).toBe("none");
  });

  it("an unjudgeable tick never fires", () => {
    expect(decideDedupeAlert(false, unjudgeable)).toBe("none");
  });

  it("an unjudgeable tick never clears an active alarm either — an outage is not a recovery", () => {
    expect(decideDedupeAlert(true, unjudgeable)).toBe("none");
  });

  it("a partially readable sample (one window null) is unjudgeable, not half-judged", () => {
    expect(decideDedupeAlert(true, { polluted: false, recentShare: 0.2, baselineShare: null })).toBe("none");
  });
});
