import { describe, expect, it } from "vitest";
import { linearMirrorProject, linearStatus, linearStatusOrNull } from "@/lib/ingest/sources/linear-normalize";

// Spec (brain-api v1.4): inbound status mapping reuses the SINGLE ingest mapper — a state NAMED
// like a brain status wins, else Linear's raw state.type (1-L "canceled") maps by group. The
// strict variant returns null for an unresolvable state (the contract treats that as a CONFLICT,
// never a silent default). Inbound must NEVER route through the 2-L `StateGroup` spelling.

describe("linearStatusOrNull / linearStatus", () => {
  it("maps by name override first (a 'Blocked' started state is blocked, not in_progress)", () => {
    expect(linearStatusOrNull("Blocked", "started")).toBe("blocked");
    expect(linearStatusOrNull("In Progress", "started")).toBe("in_progress");
  });

  it("maps Linear's 1-L 'canceled' type to done — the canceled/cancelled fork can't mis-map", () => {
    expect(linearStatusOrNull("Canceled", "canceled")).toBe("done");
    expect(linearStatusOrNull("Duplicate", "canceled")).toBe("done");
    // The 2-L spelling is NOT a Linear state.type; only the name-override path could resolve it.
    expect(linearStatusOrNull("Cancelled", "cancelled")).toBeNull();
  });

  it("maps the remaining groups by type", () => {
    expect(linearStatusOrNull("Icebox", "backlog")).toBe("backlog");
    expect(linearStatusOrNull("Todo", "unstarted")).toBe("ready");
    expect(linearStatusOrNull("Doing", "started")).toBe("in_progress");
    expect(linearStatusOrNull("Shipped", "completed")).toBe("done");
  });

  it("a state literally named Backlog resolves by name even with an unknown type", () => {
    expect(linearStatusOrNull("Backlog", "mystery")).toBe("backlog");
  });

  it("returns null for an unresolvable state (unknown name AND unknown type) — conflict, not default", () => {
    expect(linearStatusOrNull("Weird", "mystery")).toBeNull();
    expect(linearStatusOrNull(undefined, undefined)).toBeNull();
  });

  it("linearStatus keeps the ingest default (backlog) for unresolvable states", () => {
    expect(linearStatus("Weird", "mystery")).toBe("backlog");
    expect(linearStatus("Blocked", "started")).toBe("blocked");
  });
});

describe("linearMirrorProject", () => {
  it("derives the deterministic mirror slug ingest and adopt share", () => {
    expect(linearMirrorProject("ENG")).toBe("linear-eng");
    expect(linearMirrorProject("Team Ops!")).toBe("linear-team-ops");
    expect(linearMirrorProject("")).toBe("linear-team");
  });
});
