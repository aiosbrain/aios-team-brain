import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDITFIX-25 (AIO-1062) — spec §Flow 6 / AC09, the NARROW pipeline-health admission on Pulse.
 *
 * Pulse hands `getPipelineHealth`'s result to the CLIENT `PipelineHealthBanner` as props. The banner
 * clips each leg's error to 160 characters and can be dismissed — but both happen in the browser, after
 * the full `PipelineLeg.error` strings have already been serialized into the RSC payload. AUDITFIX-25
 * makes that string a labelled compound naming a team's forbidden project→group edges, so the fetch
 * itself must be admitted by posture: `canAccessAdmin({ role: me.role, tier: me.tier })`, where
 * `me.tier` is the membership-derived posture `resolveTeamContext` already resolved.
 *
 * ⚠️ ONLY that fetch. `isAdmin` (role alone) keeps driving onboarding, usage/spend scope, metrics and
 * LLM health exactly as before — narrowing `isAdmin` itself would change four unrelated surfaces, and
 * every "unchanged" assertion below exists to catch that.
 */

const TEAM = { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" };
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  serverClient: vi.fn(),
  resolveTeamContext: vi.fn(),
  getPipelineHealth: vi.fn(),
  getLlmHealth: vi.fn(),
  getPulseMetrics: vi.fn(),
  resolveContentView: vi.fn(),
  decisionsCardWindow: vi.fn(),
}));

vi.mock("@/lib/db/server", () => ({ serverClient: h.serverClient }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ admin: true }) }));
vi.mock("@/lib/auth/team-context", () => ({ resolveTeamContext: h.resolveTeamContext }));
vi.mock("@/lib/auth/admin-access", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/admin-access")>();
  return { ...real, canAccessAdmin: vi.fn(real.canAccessAdmin) };
});
vi.mock("@/lib/ingest/pipeline-health", () => ({ getPipelineHealth: h.getPipelineHealth }));
vi.mock("@/lib/query/llm-health", () => ({ getLlmHealth: h.getLlmHealth }));
vi.mock("@/lib/metrics/pulse", () => ({ getPulseMetrics: h.getPulseMetrics }));
vi.mock("@/lib/access/admission", () => ({
  resolveContentView: h.resolveContentView,
  provenanceCtxFor: () => ({ ctx: true }),
  contentLabelTier: () => "team",
}));
vi.mock("@/lib/access/structured-windows", () => ({ decisionsCardWindow: h.decisionsCardWindow }));
// The page only BUILDS the element tree; nothing below is ever invoked from this tier.
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("lucide-react", () => ({ Rocket: () => null, ChevronRight: () => null, Loader2: () => null }));
vi.mock("@/components/admin/pipeline-health-banner", () => ({ PipelineHealthBanner: () => null }));
vi.mock("@/components/admin/generation-health-banner", () => ({ GenerationHealthBanner: () => null }));
vi.mock("@/components/copy-snippet", () => ({ CopySnippet: () => null }));
vi.mock("@/components/dashboard/ask-bar", () => ({ AskBar: () => null }));
vi.mock("@/components/dashboard/kpi-band", () => ({ KpiBand: () => null }));
vi.mock("@/components/dashboard/range-selector", () => ({ RangeSelector: () => null }));
vi.mock("@/components/dashboard/decisions-card", () => ({ DecisionsCard: () => null }));
vi.mock("@/components/dashboard/working-on", () => ({ WorkingOn: () => null }));
vi.mock("@/components/dashboard/workstation-setup", () => ({ WorkstationSetup: () => null }));
vi.mock("@/components/learning/arcs-panel", () => ({ ArcsPanel: () => null }));
vi.mock("@/components/learning/timeline-panel", () => ({ TimelinePanel: () => null }));
vi.mock("@/components/learning/events-feed", () => ({ EventsFeed: () => null }));
vi.mock("@/components/learning/facts-feed", () => ({ FactsFeed: () => null }));
vi.mock("@/components/charts/knowledge-growth", () => ({ KnowledgeGrowth: () => null }));
vi.mock("@/components/charts/usage-chart", () => ({ UsageChart: () => null }));
vi.mock("@/components/charts/task-funnel", () => ({ TaskFunnel: () => null }));

import TeamHome from "@/app/t/[team]/page";
import { canAccessAdmin } from "@/lib/auth/admin-access";
import { PipelineHealthBanner } from "@/components/admin/pipeline-health-banner";
import { GenerationHealthBanner } from "@/components/admin/generation-health-banner";
import { UsageChart } from "@/components/charts/usage-chart";
import { AskBar } from "@/components/dashboard/ask-bar";

/** Past the banner's 160-character raw clip: what the client would hide is still in the props. */
const LONG_ERROR = `census: 3 unsanctioned edge(s) on system projects: ${"general→vendors-".repeat(12)}BEYOND-160-MARKER`;
const PIPELINE_HEALTH = {
  legs: [],
  failing: [{ source: "access_bootstrap", ok: false, error: LONG_ERROR, diagnosis: null, at: "", stale: false, failureClass: "confirmed", failingSince: null }],
  healthy: false,
};
const LLM_HEALTH = { marker: "llm-health" };
const PULSE = { kpis: {}, usage: [], knowledge: [], funnel: [] };

type Me = { role: string; tier: unknown };

/** The two session-client reads Pulse makes before deciding its home state. */
function homeDb(opts: { itemCount: number; connectedKey: boolean }) {
  const chain = (result: unknown) => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    return q;
  };
  return {
    from(table: string) {
      if (table === "items") return chain({ count: opts.itemCount, error: null });
      if (table === "api_keys") {
        return chain({
          data: opts.connectedKey
            ? [{ id: "k1", key_id: "kid", name: "laptop", created_at: "2026-09-01T00:00:00.000Z", last_used_at: "2026-09-02T00:00:00.000Z", revoked_at: null }]
            : [],
          error: null,
        });
      }
      throw new Error(`unexpected session read of '${table}'`);
    },
  };
}

function arrange(me: Me, opts: { itemCount?: number; connectedKey?: boolean } = {}) {
  h.serverClient.mockResolvedValue(homeDb({ itemCount: opts.itemCount ?? 5, connectedKey: opts.connectedKey ?? true }));
  h.resolveTeamContext.mockResolvedValue({
    team: TEAM,
    me: { id: MEMBER_ID, role: me.role, tier: me.tier, displayName: "Ada Lovelace", status: "active" },
    userId: "33333333-3333-4333-8333-333333333333",
  });
}

const render = () => TeamHome({ params: Promise.resolve({ team: TEAM.slug }), searchParams: Promise.resolve({}) });

function find(node: unknown, match: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) find(n, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (match(node)) out.push(node);
  find((node.props as { children?: unknown }).children, match, out);
  return out;
}
const ofType = (type: unknown) => (el: ReactElement) => el.type === type;
/** Every element's own (non-child) props, serialized — what would cross to the client as props. */
const ownProps = (tree: unknown) =>
  find(tree, () => true)
    .map((el) => JSON.stringify(el.props, (key, value) => (key === "children" || isValidElement(value) ? undefined : value)))
    .join("\n");

beforeEach(() => {
  vi.mocked(canAccessAdmin).mockClear();
  for (const fn of Object.values(h)) fn.mockReset();
  h.getPipelineHealth.mockResolvedValue(PIPELINE_HEALTH);
  h.getLlmHealth.mockResolvedValue(LLM_HEALTH);
  h.getPulseMetrics.mockResolvedValue(PULSE);
  h.resolveContentView.mockResolvedValue({ admission: "member" });
  h.decisionsCardWindow.mockResolvedValue([]);
});

describe("AUDITFIX-25 AC09: Pulse fetches pipeline health only for an unrestricted admin", () => {
  it("positive control: an unrestricted admin's props carry the FULL error, past the 160-char clip", async () => {
    arrange({ role: "admin", tier: "team" });

    const tree = await render();

    expect(h.getPipelineHealth).toHaveBeenCalledTimes(1);
    expect(h.getPipelineHealth).toHaveBeenCalledWith(TEAM.id);
    const banners = find(tree, ofType(PipelineHealthBanner));
    expect(banners, "the banner is rendered").toHaveLength(1);
    // The disclosure this gate is about: the props are the whole string. The client clips what it
    // SHOWS, never what it was SENT.
    const sent = JSON.stringify(banners[0].props);
    expect(LONG_ERROR.indexOf("BEYOND-160-MARKER"), "fixture: the marker sits past the visual clip").toBeGreaterThan(160);
    expect(sent, "the full raw error is serialized to the client").toContain("BEYOND-160-MARKER");
  });

  describe.each([
    { name: "an external-posture admin", me: { role: "admin", tier: "external" } },
    { name: "an admin with an unknown posture value", me: { role: "admin", tier: "partner" } },
    { name: "an admin whose posture is missing", me: { role: "admin", tier: undefined } },
  ])("$name", ({ me }) => {
    it("never fetches pipeline health and receives no banner props", async () => {
      arrange(me);

      const tree = await render();

      // MUTATION-SENSITIVE: this is the assertion the home gate exists for. On the base `isAdmin`
      // (role alone) admits the fetch, and the compound error reaches a restricted viewer's browser.
      expect(h.getPipelineHealth, "a restricted posture must not start the fetch").not.toHaveBeenCalled();
      expect(find(tree, ofType(PipelineHealthBanner)), "and nothing is handed to the client banner").toEqual([]);
      expect(ownProps(tree), "no trace of the error in any element's props").not.toContain("BEYOND-160-MARKER");
    });

    it("keeps every OTHER admin behaviour: LLM health, team-scoped usage, admin metrics", async () => {
      arrange(me);

      const tree = await render();

      expect(tree, "the dashboard still renders").not.toBeNull();
      expect(find(tree, ofType(AskBar)), "precondition: this is the dashboard, not the bootstrap screen").toHaveLength(1);
      // LLM health stays ROLE-only (spec: "Home LLM health stays role-only").
      expect(h.getLlmHealth).toHaveBeenCalledTimes(1);
      expect(h.getLlmHealth).toHaveBeenCalledWith(TEAM.id);
      const generation = find(tree, ofType(GenerationHealthBanner));
      expect(generation).toHaveLength(1);
      expect((generation[0].props as { health: unknown }).health).toBe(LLM_HEALTH);
      // The shared `isAdmin` is untouched: metrics are still admin-scoped, with the real posture.
      expect(h.getPulseMetrics).toHaveBeenCalledTimes(1);
      expect(h.getPulseMetrics.mock.calls[0][1]).toBe(TEAM.id);
      expect(h.getPulseMetrics.mock.calls[0][3]).toMatchObject({ isAdmin: true, memberId: MEMBER_ID, tier: me.tier });
      const usage = find(tree, ofType(UsageChart));
      expect(usage).toHaveLength(1);
      expect((usage[0].props as { scope: string }).scope, "usage/spend stays team-scoped for the admin role").toBe("team");
    });

    it("keeps admin onboarding: an empty team still shows the bootstrap checklist", async () => {
      arrange(me, { itemCount: 0, connectedKey: false });

      const tree = await render();

      // `pickHomeState` reads the shared `isAdmin`. Narrowing it to the posture gate would drop this
      // admin onto the member dashboard of an empty team.
      const checklist = find(tree, (el) => typeof el.type === "function" && el.type.name === "SetupChecklist");
      expect(checklist, "the admin bootstrap screen is unchanged").toHaveLength(1);
      expect(find(tree, ofType(AskBar)), "and the dashboard is not rendered").toEqual([]);
      expect(h.getPulseMetrics).not.toHaveBeenCalled();
      expect(h.getPipelineHealth).not.toHaveBeenCalled();
    });
  });

  it("consults the EXISTING canAccessAdmin with the membership-derived posture", async () => {
    arrange({ role: "admin", tier: "external" });

    await render();

    // Not a new policy and not the stored record: `me.tier` IS posture (resolveTeamContext, PRET-4).
    expect(canAccessAdmin).toHaveBeenCalledWith({ role: "admin", tier: "external" });
  });

  describe.each([
    { name: "an internal member", me: { role: "member", tier: "team" } },
    { name: "an internal lead", me: { role: "lead", tier: "team" } },
    { name: "an external member", me: { role: "member", tier: "external" } },
  ])("$name (unchanged)", ({ me }) => {
    it("fetches neither health read and sees their own usage", async () => {
      arrange(me);

      const tree = await render();

      expect(h.getPipelineHealth).not.toHaveBeenCalled();
      expect(h.getLlmHealth).not.toHaveBeenCalled();
      expect(find(tree, ofType(PipelineHealthBanner))).toEqual([]);
      expect(find(tree, ofType(GenerationHealthBanner))).toEqual([]);
      expect(h.getPulseMetrics.mock.calls[0][3]).toMatchObject({ isAdmin: false, tier: me.tier });
      expect((find(tree, ofType(UsageChart))[0].props as { scope: string }).scope).toBe("your");
    });
  });

  it("an unrestricted admin's empty-team bootstrap screen fetches no health (unchanged)", async () => {
    arrange({ role: "admin", tier: "team" }, { itemCount: 0, connectedKey: false });

    const tree = await render();

    expect(find(tree, (el) => typeof el.type === "function" && el.type.name === "SetupChecklist")).toHaveLength(1);
    expect(h.getPipelineHealth).not.toHaveBeenCalled();
    expect(h.getLlmHealth).not.toHaveBeenCalled();
  });

  it("NON-MUTATION assertion: a posture-resolution throw never reaches the health fetch", async () => {
    h.serverClient.mockResolvedValue(homeDb({ itemCount: 5, connectedKey: true }));
    h.resolveTeamContext.mockRejectedValue(new Error("posture read failed: injected"));

    await expect(render()).rejects.toThrow("posture read failed: injected");

    // `resolveTeamContext` resolves posture and is awaited before anything else, so this holds with
    // or without the gate (spec round 3 F10). It is recorded as an invariant, and deliberately NOT
    // claimed as evidence that the gate works — removing the gate does not turn it red.
    expect(h.getPipelineHealth).not.toHaveBeenCalled();
    expect(h.getLlmHealth).not.toHaveBeenCalled();
    expect(h.getPulseMetrics).not.toHaveBeenCalled();
  });

  it("no team context renders nothing and fetches nothing (unchanged)", async () => {
    h.serverClient.mockResolvedValue(homeDb({ itemCount: 5, connectedKey: true }));
    h.resolveTeamContext.mockResolvedValue(null);

    expect(await render()).toBeNull();
    expect(h.getPipelineHealth).not.toHaveBeenCalled();
    expect(h.getLlmHealth).not.toHaveBeenCalled();
  });
});
