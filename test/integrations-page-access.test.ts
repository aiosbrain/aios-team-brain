import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/ingest/fake-supabase";

/**
 * AUDITFIX-25 (AIO-1062) — spec §Flow 5 / AC09, the PAGE-LOCAL gate on Admin → Integrations.
 *
 * The `/admin` layout renders "Admins only" for a non-admin, and the installed Next 16.3 authentication
 * guide (`node_modules/next/dist/docs/01-app/02-guides/authentication.md`, "Layouts and auth checks") is
 * explicit that this is not a boundary: "a layout that hides or swaps them does not stop them from
 * running or from appearing in the RSC Payload". This page runs `adminClient()` reads — the ledger
 * (`listRecentIngestRuns`), `getPipelineHealth`, retrieval health, codebase freshness — and AUDITFIX-25
 * puts a team's structured bootstrap evidence into exactly those rows. So the page must admit the viewer
 * ITSELF, from the membership-derived posture, BEFORE any of them starts.
 *
 * These are page-unit spies: they pin the ORDER and the ABSENCE of the elevated reads, which the
 * production HTTP tier cannot observe (it sees only bytes). The HTTP tier owns the transport proof.
 *
 * The session database is the repo's `FakeSupabase` (it honours `.eq()` filters), so `status='active'`
 * and the team filter are exercised rather than assumed. `canAccessAdmin` is the REAL policy helper
 * wrapped in a spy — a mocked policy would prove nothing about what the page admits.
 */

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const TEAM_SLUG = "acme";

const h = vi.hoisted(() => ({
  /** Every spy appends its own name as it STARTS, so ordering is a recorded fact, not an inference. */
  calls: [] as string[],
  serverClient: vi.fn(),
  adminClient: vi.fn(),
  getSessionUser: vi.fn(),
  resolveViewerPosture: vi.fn(),
  listIntegrations: vi.fn(),
  listRecentIngestRuns: vi.fn(),
  getPipelineHealth: vi.fn(),
  getCodebaseFreshness: vi.fn(),
  getRetrievalHealth: vi.fn(),
  smallRoutingEvidence: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/lib/db/server", () => ({ serverClient: h.serverClient }));
vi.mock("@/lib/db/admin", () => ({ adminClient: h.adminClient }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: h.getSessionUser }));
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: h.resolveViewerPosture }));
vi.mock("@/lib/auth/admin-access", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/admin-access")>();
  return {
    ...real,
    canAccessAdmin: vi.fn((member: Parameters<typeof real.canAccessAdmin>[0]) => {
      h.calls.push("canAccessAdmin");
      return real.canAccessAdmin(member);
    }),
  };
});
vi.mock("@/lib/integrations/read", () => ({ listIntegrations: h.listIntegrations }));
vi.mock("@/lib/ingest/runs", () => ({ listRecentIngestRuns: h.listRecentIngestRuns }));
vi.mock("@/lib/ingest/pipeline-health", () => ({ getPipelineHealth: h.getPipelineHealth }));
vi.mock("@/lib/metrics/codebases", () => ({ getCodebaseFreshness: h.getCodebaseFreshness }));
vi.mock("@/lib/query/retrieval-health", () => ({ getRetrievalHealth: h.getRetrievalHealth }));
vi.mock("@/lib/llm/small-model-health", () => ({ smallRoutingEvidence: h.smallRoutingEvidence }));
// `lib/query/answering` drags the integrations writer and the staging runtime policy in; the page uses
// only its two pure normalizers, and only on the admitted path.
vi.mock("@/lib/query/answering", () => ({
  normalizeAnsweringProvider: (v: unknown) => (typeof v === "string" ? v : null),
  normalizeExtractionProvider: (v: unknown) => (typeof v === "string" ? v : null),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect, notFound: h.notFound }));
// The page's children are client components with their own dependency graphs. The page function only
// BUILDS the element tree — it never invokes them — so inert stand-ins are all this tier needs.
vi.mock("@/components/admin/integrations-manager", () => ({ IntegrationsManager: () => null }));
vi.mock("@/components/admin/github-repos-panel", () => ({ GithubReposPanel: () => null }));
vi.mock("@/components/admin/openrouter-panel", () => ({ OpenrouterPanel: () => null }));
vi.mock("@/components/admin/member-onboarding-panel", () => ({ MemberOnboardingPanel: () => null }));
vi.mock("@/components/admin/ingest-runs-panel", () => ({ IngestRunsPanel: () => null }));
vi.mock("@/components/admin/retrieval-health-card", () => ({ RetrievalHealthCard: () => null }));
vi.mock("@/components/admin/pipeline-health-banner", () => ({ PipelineHealthBanner: () => null }));

import IntegrationsPage from "@/app/t/[team]/admin/integrations/page";
import { canAccessAdmin } from "@/lib/auth/admin-access";
import { IngestRunsPanel } from "@/components/admin/ingest-runs-panel";
import { PipelineHealthBanner } from "@/components/admin/pipeline-health-banner";

/** The reads that go through `adminClient()` or the ledger — what the gate exists to protect. */
const ELEVATED = [
  "listIntegrations",
  "listRecentIngestRuns",
  "getPipelineHealth",
  "getCodebaseFreshness",
  "getRetrievalHealth",
  "smallRoutingEvidence",
] as const;

/** A recognisable ledger row: if the page renders, this is what would be serialized to the viewer. */
const LEDGER_ROWS = [{ id: 1, source: "access_bootstrap", errors: ["census: PRIVATE-EVIDENCE-MARKER"] }];
const HEALTH = { legs: [], failing: [], healthy: true };

type MemberRow = {
  id: string;
  team_id: string;
  auth_user_id: string;
  role: string;
  /** The STORED invite-default record. Never an access input (PRET-4) — see the substitution case. */
  tier: string;
  status: string;
};

const adminMember = (over: Partial<MemberRow> = {}): MemberRow => ({
  id: MEMBER_ID,
  team_id: TEAM_ID,
  auth_user_id: USER_ID,
  role: "admin",
  tier: "team",
  status: "active",
  ...over,
});

function sessionDb(members: MemberRow[]): FakeSupabase {
  const fake = new FakeSupabase();
  fake.tables.teams = [
    { id: TEAM_ID, slug: TEAM_SLUG, primary_pm_provider: null, answering_provider: null },
    { id: OTHER_TEAM_ID, slug: "other", primary_pm_provider: null, answering_provider: null },
  ];
  fake.tables.members = members as unknown as Record<string, unknown>[];
  return fake;
}

/** A session client whose `members` read comes back as an adapter error, everything else real. */
function sessionDbWithFailingMembersRead(members: MemberRow[]) {
  const fake = sessionDb(members);
  const failing = {
    select: () => failing,
    eq: () => failing,
    maybeSingle: async () => ({ data: null, error: { message: "members read exploded" } }),
  };
  return { from: (table: string) => (table === "members" ? failing : fake.from(table)) };
}

function arrange(opts: { members: MemberRow[]; user?: { id: string } | null; posture?: unknown }) {
  h.serverClient.mockResolvedValue(sessionDb(opts.members));
  h.getSessionUser.mockResolvedValue(opts.user === undefined ? { id: USER_ID } : opts.user);
  h.resolveViewerPosture.mockImplementation(async () => {
    h.calls.push("resolveViewerPosture");
    return opts.posture === undefined ? "team" : opts.posture;
  });
}

const render = () => IntegrationsPage({ params: Promise.resolve({ team: TEAM_SLUG }) });

const elevatedCalls = () => h.calls.filter((c) => (ELEVATED as readonly string[]).includes(c));

function find(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) find(n, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  find((node.props as { children?: unknown }).children, type, out);
  return out;
}

beforeEach(() => {
  h.calls.length = 0;
  vi.mocked(canAccessAdmin).mockClear();
  for (const fn of [
    h.serverClient, h.adminClient, h.getSessionUser, h.resolveViewerPosture, h.listIntegrations,
    h.listRecentIngestRuns, h.getPipelineHealth, h.getCodebaseFreshness, h.getRetrievalHealth,
    h.smallRoutingEvidence, h.redirect, h.notFound,
  ]) fn.mockReset();
  h.adminClient.mockReturnValue({ admin: true });
  const record = <T>(name: string, value: T) => async () => {
    h.calls.push(name);
    return value;
  };
  h.listIntegrations.mockImplementation(record("listIntegrations", []));
  h.listRecentIngestRuns.mockImplementation(record("listRecentIngestRuns", LEDGER_ROWS));
  h.getPipelineHealth.mockImplementation(record("getPipelineHealth", HEALTH));
  h.getCodebaseFreshness.mockImplementation(record("getCodebaseFreshness", []));
  h.getRetrievalHealth.mockImplementation(record("getRetrievalHealth", null));
  h.smallRoutingEvidence.mockImplementation(record("smallRoutingEvidence", { state: "unavailable" }));
});

describe("AUDITFIX-25 AC09: Admin → Integrations admits the viewer before any elevated read", () => {
  it("positive control: an unrestricted admin gets every read and the ledger panel", async () => {
    arrange({ members: [adminMember()] });

    const tree = await render();

    // Without this the denial cases below prove nothing — a page that never read anything would
    // satisfy every "was not called" assertion in the file.
    expect(tree, "the admitted page renders").not.toBeNull();
    for (const read of ["listIntegrations", "listRecentIngestRuns", "getPipelineHealth", "getCodebaseFreshness", "getRetrievalHealth"]) {
      expect(h.calls.filter((c) => c === read), `${read} runs exactly once for an admitted admin`).toHaveLength(1);
    }
    expect(h.listRecentIngestRuns).toHaveBeenCalledWith(expect.anything(), TEAM_ID, 30);
    expect(h.getPipelineHealth).toHaveBeenCalledWith(TEAM_ID);
    expect(h.getRetrievalHealth).toHaveBeenCalledWith(TEAM_ID);
    // `listIntegrations` keeps its own role gate (defense in depth) and still receives the role.
    expect(h.listIntegrations).toHaveBeenCalledWith(expect.anything(), TEAM_ID, { role: "admin" });

    const panels = find(tree, IngestRunsPanel);
    expect(panels, "the ledger panel is in the tree").toHaveLength(1);
    expect((panels[0].props as { runs: unknown }).runs, "and carries the rows the reader returned").toBe(LEDGER_ROWS);
    expect(find(tree, PipelineHealthBanner), "the health banner is in the tree").toHaveLength(1);
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.notFound).not.toHaveBeenCalled();
  });

  it("resolves posture ONCE, from the membership, and reuses it for the freshness read", async () => {
    arrange({ members: [adminMember()] });

    await render();

    expect(h.resolveViewerPosture, "one resolution per render — the gate and the read share it").toHaveBeenCalledTimes(1);
    expect(h.resolveViewerPosture).toHaveBeenCalledWith(expect.anything(), TEAM_ID, MEMBER_ID);
    expect(h.getCodebaseFreshness).toHaveBeenCalledWith(expect.anything(), TEAM_ID, "team");
    // The gate is the EXISTING helper, fed the resolved posture — not a new policy, not the stored tier.
    expect(canAccessAdmin).toHaveBeenCalledWith({ role: "admin", tier: "team" });
  });

  it("orders the gate BEFORE the first elevated read, even for an admitted admin", async () => {
    arrange({ members: [adminMember()] });

    await render();

    const firstElevated = h.calls.findIndex((c) => (ELEVATED as readonly string[]).includes(c));
    expect(firstElevated, "precondition: elevated reads did run").toBeGreaterThanOrEqual(0);
    // On the base the posture `await` sits INSIDE the `Promise.all` array literal, as the fourth
    // element's argument — so `listIntegrations`, `listRecentIngestRuns` and `getPipelineHealth` have
    // already been called by the time posture is known. An admitted viewer hides that; a denied or
    // faulted one cannot be stopped by a decision taken after the reads started.
    expect(h.calls.indexOf("resolveViewerPosture"), "posture resolves first").toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("resolveViewerPosture"), "posture resolves before any elevated read").toBeLessThan(firstElevated);
    expect(h.calls.indexOf("canAccessAdmin"), "the page consults canAccessAdmin itself").toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("canAccessAdmin"), "and does so before any elevated read").toBeLessThan(firstElevated);
    expect(h.calls.indexOf("resolveViewerPosture"), "posture feeds the gate, not the other way round").toBeLessThan(
      h.calls.indexOf("canAccessAdmin")
    );
  });

  describe.each([
    {
      name: "an internal non-admin member",
      members: [adminMember({ role: "member" })],
      posture: "team",
    },
    {
      name: "an internal lead",
      members: [adminMember({ role: "lead" })],
      posture: "team",
    },
    {
      // The STORED record says `team`; posture (everyone-membership) says external. Substituting
      // `members.tier` for the resolved posture admits this viewer.
      name: "an admin whose resolved posture is external (stored tier 'team' must not be substituted)",
      members: [adminMember({ tier: "team" })],
      posture: "external",
    },
    {
      name: "an admin with an unknown posture value",
      members: [adminMember()],
      posture: "partner",
    },
    {
      name: "an admin whose posture resolves to nothing",
      members: [adminMember()],
      posture: null,
    },
    {
      name: "a disabled admin",
      members: [adminMember({ status: "disabled" })],
      posture: "team",
    },
    {
      name: "an invited (not yet active) admin",
      members: [adminMember({ status: "invited" })],
      posture: "team",
    },
    {
      name: "an admin of a DIFFERENT team",
      members: [adminMember({ team_id: OTHER_TEAM_ID })],
      posture: "team",
    },
    {
      name: "a signed-in user with no membership at all",
      members: [],
      posture: "team",
    },
    {
      name: "another user's admin membership",
      members: [adminMember({ auth_user_id: "55555555-5555-4555-8555-555555555555" })],
      posture: "team",
    },
  ])("denies $name", ({ members, posture }) => {
    it("returns the null leaf and starts no elevated read", async () => {
      arrange({ members, posture });

      const tree = await render();

      expect(elevatedCalls(), "no adminClient/ledger read may start for a denied viewer").toEqual([]);
      // The denial LEAF is `null` (HTTP 200, the layout's "Admins only" stays the only denial copy):
      // no redirect, no notFound, and no second sentinel rendered from this segment.
      expect(tree, "the denial leaf is exactly null").toBeNull();
      expect(h.redirect, "denial is not a redirect").not.toHaveBeenCalled();
      expect(h.notFound, "denial is not a 404").not.toHaveBeenCalled();
    });
  });

  it("denies an anonymous request even when an admin membership row exists for the team", async () => {
    arrange({ members: [adminMember()], user: null });

    const tree = await render();

    expect(elevatedCalls()).toEqual([]);
    expect(tree).toBeNull();
    expect(h.resolveViewerPosture, "no member, so there is no posture to resolve").not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when posture resolution throws: no elevated read has started", async () => {
    arrange({ members: [adminMember()] });
    h.resolveViewerPosture.mockImplementation(async () => {
      h.calls.push("resolveViewerPosture");
      throw new Error("posture read failed: injected");
    });

    // The spec pins the READS, not whether the fault surfaces as a thrown render or the null leaf, so
    // both settle shapes are accepted here — and neither may have rendered content.
    const settled = await render().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    expect(h.calls, "precondition: posture resolution was attempted").toContain("resolveViewerPosture");
    // On the base three elevated reads are already in flight when the posture await rejects.
    expect(elevatedCalls(), "a posture fault must precede every elevated read").toEqual([]);
    if (settled.status === "fulfilled") expect(settled.value, "a swallowed fault renders nothing").toBeNull();
  });

  it("FAILS CLOSED when the membership read errors", async () => {
    h.serverClient.mockResolvedValue(sessionDbWithFailingMembersRead([adminMember()]));
    h.getSessionUser.mockResolvedValue({ id: USER_ID });
    h.resolveViewerPosture.mockImplementation(async () => {
      h.calls.push("resolveViewerPosture");
      return "team";
    });

    const tree = await render();

    expect(elevatedCalls(), "an unresolved membership is not an admin").toEqual([]);
    expect(tree).toBeNull();
  });

  it("invariant (not a gate mutation): a session-resolution throw starts no elevated read", async () => {
    arrange({ members: [adminMember()] });
    h.getSessionUser.mockRejectedValue(new Error("session store exploded"));

    await expect(render()).rejects.toThrow("session store exploded");

    // Already true on the base — the session is awaited before anything else — and recorded so a
    // later reordering that moves a read above it is caught here.
    expect(elevatedCalls()).toEqual([]);
  });

  it("an unknown team still renders nothing and reads nothing", async () => {
    arrange({ members: [adminMember()] });

    const tree = await IntegrationsPage({ params: Promise.resolve({ team: "no-such-team" }) });

    expect(tree).toBeNull();
    expect(elevatedCalls()).toEqual([]);
  });
});
