import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { IdentityConflicts } from "@/components/admin/identity-conflicts";
import type { IdentityConflictRow } from "@/lib/identity/discovery-conflicts";

/**
 * AIO-1167 R45 (AC-08) — what an Admin SEES for refused automatic identity links.
 *
 * Spec. A row states that the automatic link was refused and the existing mapping kept, names the
 * account, the observed member and who held it then, shows the mapping NOW and whether the event is
 * still standing, and links to each member's row (the existing Identities control). A read failure
 * says the diagnostic is unavailable — never "none". A viewer who is not allowed sees nothing at all.
 */

const ROW: IdentityConflictRow = {
  observedAt: "2026-10-30T12:34:00.000Z", occurrences: 3, provider: "gdrive", externalId: "permission:L",
  candidate: { id: "m-alice", displayName: "Alice" }, heldThen: { id: "m-bob", displayName: "Bob" },
  current: { state: "unreviewed", holder: { id: "m-bob", displayName: "Bob" }, revision: 0 },
  standing: "still_conflicting",
};

const render = (page: Parameters<typeof IdentityConflicts>[0]["page"], nextHref: string | null = null) =>
  renderToStaticMarkup(createElement(IdentityConflicts, { page, nextHref }));

describe("refused automatic identity links — Admin view", () => {
  it("states the refusal and shows the account, both members, the mapping now and its standing", () => {
    const html = render({ status: "ok", rows: [ROW], nextCursor: null });
    expect(html).toContain("automatic link was refused and the existing mapping was kept");
    expect(html).toContain("Google Drive · permission:L");
    expect(html).toContain('href="#member-m-alice"');
    expect(html).toContain('href="#member-m-bob"');
    expect(html).toContain("legacy mapping that was never reviewed");
    expect(html).toContain("Still mapped to another member");
    expect(html).toContain("2026-10-30 12:34 UTC");
    expect(html).toContain("3×");
  });

  it("a resolved event reads as history: mapped to the candidate now, or unlinked", () => {
    const now = render({ status: "ok", nextCursor: null, rows: [{
      ...ROW, standing: "now_candidate", current: { state: "linked", holder: { id: "m-alice", displayName: "Alice" }, revision: 4 },
    }] });
    expect(now).toContain("Linked to Alice (revision 4)");
    expect(now).toContain("Since mapped to the observed member");
    const gone = render({ status: "ok", nextCursor: null, rows: [{ ...ROW, standing: "unlinked", current: { state: "unlinked", holder: null, revision: 2 } }] });
    expect(gone).toContain("Since unlinked");
  });

  it("a read failure is shown as unavailable, never as none", () => {
    const html = render({ status: "unavailable" });
    expect(html).toContain("unavailable");
    expect(html).not.toContain("No automatic links have been refused");
  });

  it("an empty page says none; a forbidden viewer sees nothing at all; a next page is linked", () => {
    expect(render({ status: "ok", rows: [], nextCursor: null })).toContain("No automatic links have been refused");
    expect(render({ status: "forbidden" })).toBe("");
    expect(render({ status: "ok", rows: [ROW], nextCursor: "c" }, "/t/x/admin/members?conflicts=c")).toContain("Older refused links");
  });
});
