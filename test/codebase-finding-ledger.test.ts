import { describe, expect, it } from "vitest";
import { decideFindingTransition } from "@/lib/codebases/finding-ledger";

describe("codebase finding lifecycle", () => {
  it("detects a new finding", () => {
    expect(
      decideFindingTransition({
        currentStatus: null,
        present: true,
        evidenceStatus: "complete",
      })
    ).toEqual({ status: "open", event: "detected", mutatesCurrent: true });
  });

  it.each(["partial", "missing", "stale", "error"] as const)(
    "does not resolve absence from %s evidence",
    (evidenceStatus) => {
      expect(
        decideFindingTransition({ currentStatus: "open", present: false, evidenceStatus })
      ).toBeNull();
    }
  );

  it("resolves absence only from complete evidence", () => {
    expect(
      decideFindingTransition({
        currentStatus: "reopened",
        present: false,
        evidenceStatus: "complete",
      })
    ).toEqual({ status: "resolved", event: "resolved", mutatesCurrent: true });
  });

  it("reopens a resolved fingerprint when it returns", () => {
    expect(
      decideFindingTransition({
        currentStatus: "resolved",
        present: true,
        evidenceStatus: "complete",
      })
    ).toEqual({ status: "reopened", event: "reopened", mutatesCurrent: true });
  });

  it("preserves future decision states when a finding is observed", () => {
    expect(
      decideFindingTransition({
        currentStatus: "risk_accepted",
        present: true,
        evidenceStatus: "complete",
      })
    ).toEqual({ status: "risk_accepted", event: "observed", mutatesCurrent: true });
  });

  it("records older analysis without mutating current state", () => {
    expect(
      decideFindingTransition({
        currentStatus: "open",
        present: true,
        evidenceStatus: "complete",
        olderThanCurrent: true,
      })
    ).toEqual({ status: "open", event: "stale_analysis", mutatesCurrent: false });
  });

  it("retains a previously unseen historical fingerprint without making it active", () => {
    expect(
      decideFindingTransition({
        currentStatus: null,
        present: true,
        evidenceStatus: "complete",
        olderThanCurrent: true,
      })
    ).toEqual({ status: "stale_analysis", event: "stale_analysis", mutatesCurrent: false });
  });
});
