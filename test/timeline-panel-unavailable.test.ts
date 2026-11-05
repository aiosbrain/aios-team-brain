import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R42 F1 — the Pulse Timeline panel degrades ALONE when the timeline is expectedly unavailable.
 *
 * Spec. `getCachedWorkTimeline` refuses, by design, while an identity-attribution repair is pending
 * (`AttributionRepairPendingError`) and when authorization moves under both read attempts
 * (`TimelineAuthorizationChangedError`). The timeline routes answer both with a retryable 503. The
 * server-rendered panel sits inside `<Suspense>`, which does not catch errors — an escaping error
 * replaces the WHOLE home page with the segment error boundary. So the panel must:
 *   · render a temporary-unavailable notice for each expected error (the page keeps rendering);
 *   · show NO ledger in that state — never stale evidence, and no "earlier days" control that would
 *     read the same refused timeline;
 *   · still throw anything unexpected (an unknown failure is not quietly turned into a notice).
 *
 * The REAL error classes are thrown (imported from their owning modules), so this pins the panel to
 * the classes the cache layer actually raises, not to look-alikes.
 */

const h = vi.hoisted(() => ({
  read: null as null | (() => Promise<unknown>),
  calls: [] as unknown[][],
}));

vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ marker: "admin-client" }) }));
vi.mock("@/lib/dashboard/timeline-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/timeline-cache")>()),
  getCachedWorkTimeline: (...args: unknown[]) => {
    h.calls.push(args);
    if (!h.read) throw new Error("test did not script the timeline read");
    return h.read();
  },
}));
// The ledger renderers are client/shared components with their own tests; stub them to markers so
// this file observes only WHICH branch the panel took.
vi.mock("@/components/dashboard/timeline-days", () => ({
  TimelineDays: ({ days }: { days: { date: string }[] }) =>
    createElement("div", { "data-ledger": days.map((d) => d.date).join(",") }),
}));
vi.mock("@/components/dashboard/timeline-load-more", () => ({
  TimelineLoadMore: ({ shownDates }: { shownDates: string[] }) =>
    createElement("div", { "data-load-more": shownDates.join(",") }),
}));

const { TimelinePanel } = await import("@/components/learning/timeline-panel");
const { AttributionRepairPendingError } = await import("@/lib/access/authorization-epoch");
const { TimelineAuthorizationChangedError } = await import("@/lib/dashboard/timeline-cache");

const PROPS = { teamId: "team-1", teamSlug: "acme", tier: "team" as const, memberId: "member-1" };

async function render(): Promise<string> {
  const element = (await TimelinePanel(PROPS)) as ReactElement;
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  h.read = null;
  h.calls = [];
});

describe("TimelinePanel — expected unavailability degrades only the panel (R42 F1)", () => {
  it("positive control: a successful read renders the ledger and the earlier-days control", async () => {
    h.read = async () => ({ days: [{ date: "2026-10-26" }], freshness: { stale: false } });
    const html = await render();
    expect(html).toContain('data-ledger="2026-10-26"');
    expect(html).toContain('data-load-more="2026-10-26"');
    expect(html).not.toContain('role="status"');
    // The panel reads as the viewing member, through the admin client (access is enforced in the builder).
    expect(h.calls).toEqual([[{ marker: "admin-client" }, "team-1", "team", "member-1"]]);
  });

  it("a pending attribution repair renders a temporary repair notice with no ledger", async () => {
    h.read = async () => { throw new AttributionRepairPendingError(); };
    const html = await render();
    expect(html).toContain('role="status"');
    expect(html).toMatch(/temporarily unavailable while work attribution is being repaired/i);
    expect(html).not.toContain("data-ledger");
    expect(html).not.toContain("data-load-more");
  });

  it("authorization changing under both attempts renders a refresh notice with no ledger", async () => {
    h.read = async () => { throw new TimelineAuthorizationChangedError(); };
    const html = await render();
    expect(html).toContain('role="status"');
    expect(html).toMatch(/access changed while it was loading/i);
    expect(html).not.toContain("data-ledger");
    expect(html).not.toContain("data-load-more");
  });

  it("the two notices are distinct, so the reader learns which condition holds", async () => {
    h.read = async () => { throw new AttributionRepairPendingError(); };
    const repair = await render();
    h.read = async () => { throw new TimelineAuthorizationChangedError(); };
    const changed = await render();
    expect(repair).not.toEqual(changed);
  });

  it("an unexpected error still propagates to the error boundary (not silently degraded)", async () => {
    const boom = new Error("relation work_timeline_cache does not exist");
    h.read = async () => { throw boom; };
    await expect(TimelinePanel(PROPS)).rejects.toBe(boom);
  });

  it("a look-alike error with the same name is NOT treated as expected (instanceof, not name)", async () => {
    const lookalike = new Error("identity attribution repair is not complete");
    lookalike.name = "AttributionRepairPendingError";
    h.read = async () => { throw lookalike; };
    await expect(TimelinePanel(PROPS)).rejects.toBe(lookalike);
  });
});

/**
 * Every caller of `getCachedWorkTimeline` must map BOTH expected errors itself. The panel shipped
 * without it because its file was unchanged while the cache layer gained the two throws; this guard
 * makes the next new caller name both classes or fail the build.
 */
describe("every getCachedWorkTimeline caller handles both expected errors", () => {
  const ROOT = join(__dirname, "..");
  const SCAN = ["app", "components", "lib"];
  const OWNER = "lib/dashboard/timeline-cache.ts";

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  const callers = SCAN.flatMap((d) => sources(join(ROOT, d)))
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }))
    .filter(({ path, text }) => path !== OWNER && /\bgetCachedWorkTimeline\s*\(/.test(text));

  it("finds the known callers (non-vacuous)", () => {
    expect(callers.map((c) => c.path)).toEqual(expect.arrayContaining([
      "components/learning/timeline-panel.tsx",
      "app/api/v1/timeline/route.ts",
      "app/api/dashboard/team-work/route.ts",
    ]));
  });

  it.each([["AttributionRepairPendingError"], ["TimelineAuthorizationChangedError"]])(
    "each caller checks instanceof %s",
    (name) => {
      const missing = callers
        .filter(({ text }) => !new RegExp(`instanceof\\s+${name}\\b`).test(text))
        .map(({ path }) => path);
      expect(missing).toEqual([]);
    },
  );
});
