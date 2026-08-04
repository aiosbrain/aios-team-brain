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

const judged = (polluted: boolean) => ({ polluted, judgeable: true });
// A refusal always reads `polluted: false, judgeable: false` — the detector's contract. Note a
// refused tick can still CARRY shares (a below-minimum sample computes them); `judgeable` is the
// only field that says whether they mean anything, which is why the machine keys on it alone.
const unjudgeable = { polluted: false, judgeable: false };

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

  it("a below-minimum sample during an active alarm is not a recovery — quiet Saturday, still polluted", () => {
    // The first cut re-derived judgeability from shares-non-null; a small sample carries shares, so
    // one quiet day inside a sustained incident sent a false "recovered" mail (review finding).
    expect(decideDedupeAlert(true, { polluted: false, judgeable: false })).toBe("none");
  });
});
