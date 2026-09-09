import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDITFIX-14 — the four admin "Run now" server actions, unit tier.
 *
 * Spec-derived from `docs/design/auditfix14-manual-context-reconcile.md` §"Outcomes" and AC14-01 /
 * AC14-05 / AC14-06 / AC14-07. What is pinned here:
 *
 *   • AUTHORIZATION FIRST. A denied caller runs neither the importer, nor the context pass, nor a
 *     revalidation. These actions are globally-invokable HTTP endpoints with no RLS behind them.
 *   • EVERY authorized attempt reconciles — a returned error, a throw, a skip and a zero-change run
 *     all leave committed items that nothing else will partition while the poller is off.
 *   • REVALIDATION happens AFTER the context stage, on every authorized attempt including the
 *     failed ones. Slack revalidated before its error return because a failed private-channel run
 *     PURGES rows; that property must survive, and the other three gain it.
 *   • `ok:true` only when the import was clean AND the context pass completed. The two admin
 *     consumers below render `error` and ignore `message`, so pending work returned as
 *     `{ok:true, message}` is invisible to the admin who caused it.
 *
 * The heavy sibling imports of `actions.ts` (graph projection, GitHub estimate, model catalogues)
 * are stubbed: they belong to actions this file does not exercise, and importing them for real
 * would make an unrelated network/DB dependency a precondition of this spec.
 */

const h = vi.hoisted(() => ({
  requireTeamAdmin: vi.fn(),
  runSlack: vi.fn(),
  runPlane: vi.fn(),
  runLinear: vi.fn(),
  runGithub: vi.fn(),
  runManualContextPass: vi.fn(),
  revalidatePath: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: h.requireTeamAdmin }));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    h.order.push("revalidate");
    return h.revalidatePath(...args);
  },
}));
vi.mock("@/lib/ingest/run", () => ({
  runSlackIngestion: h.runSlack,
  runPlaneIngestion: h.runPlane,
  runLinearIngestion: h.runLinear,
  runGithubIngestion: h.runGithub,
}));
vi.mock("@/lib/ingest/manual-context", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runManualContextPass: h.runManualContextPass,
}));
// This file is about an ENABLED deployment; the copied-staging refusal of these same four actions
// (and its production positive control) is `test/manual-sync-copy-mode.test.ts`.
vi.mock("@/lib/staging/ingest-policy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  manualIngestionVerdict: async () => ({ allowed: true, code: null, message: null }),
}));

// Unrelated dependencies of the module under import.
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ from: vi.fn() }) }));
vi.mock("@/lib/graph/run", () => ({ runGraphProjection: vi.fn() }));
vi.mock("@/lib/graph/projection-run", () => ({
  projectionRunInput: vi.fn(),
  shouldRecordProjectionRun: vi.fn(() => false),
}));
vi.mock("@/lib/ingest/runs", () => ({ recordIngestRun: vi.fn() }));
vi.mock("@/lib/integrations/manage", () => ({
  upsertIntegration: vi.fn(),
  setIntegrationSecret: vi.fn(),
  setIntegrationStatus: vi.fn(),
  deleteIntegration: vi.fn(),
  getEnabledIntegrationsWithSecrets: vi.fn(),
  saveProviderModel: vi.fn(),
}));
vi.mock("@/lib/integrations/github-link", () => ({
  linkGithubRepo: vi.fn(),
  unlinkGithubRepo: vi.fn(),
  ensureGithubIntegration: vi.fn(),
  githubReposAndToken: vi.fn(),
  countPreviouslyImportedTasks: vi.fn(),
}));
vi.mock("@/lib/integrations/github-validate", () => ({ validateGithubToken: vi.fn(), checkRepoAccess: vi.fn() }));
vi.mock("@/lib/integrations/slack-validate", () => ({ checkSlackChannels: vi.fn(), privateChannelRejection: vi.fn() }));
vi.mock("@/lib/integrations/github-estimate", () => ({ estimateGithubImport: vi.fn() }));
vi.mock("@/lib/integrations/openrouter", () => ({ validateOpenrouterKey: vi.fn(), saveOpenrouterSettings: vi.fn() }));
vi.mock("@/lib/metrics/graph-efficiency", () => ({ getGraphEfficiency: vi.fn() }));
vi.mock("@/lib/provisioning/settings", () => ({ saveProvisioningSettings: vi.fn() }));
vi.mock("@/lib/meetings/target-status-db", () => ({ setMeetingTaskStatus: vi.fn() }));
vi.mock("@/lib/llm/structured-output-support", () => ({
  checkStructuredOutputSupport: vi.fn(),
  structuredOutputWarning: vi.fn(),
}));
vi.mock("@/lib/query/answering", () => ({ resolveAnsweringKeys: vi.fn() }));
vi.mock("@/lib/api/audit", () => ({ audit: vi.fn() }));

import {
  syncGithubNow,
  syncLinearNow,
  syncPlaneNow,
  syncSlackNow,
} from "@/app/t/[team]/admin/integrations/actions";

type Action = (slug: string) => Promise<{ ok: boolean; error?: string; message?: string }>;

const ENTRIES: { name: string; action: Action; runner: () => ReturnType<typeof vi.fn>; entrypoint: string }[] = [
  { name: "slack", action: syncSlackNow, runner: () => h.runSlack, entrypoint: "slack" },
  { name: "plane", action: syncPlaneNow, runner: () => h.runPlane, entrypoint: "plane" },
  { name: "linear", action: syncLinearNow, runner: () => h.runLinear, entrypoint: "linear" },
  { name: "github", action: syncGithubNow, runner: () => h.runGithub, entrypoint: "github" },
];

const cleanRun = {
  ok: true,
  integrations: 1,
  channels: 2,
  projects: 1,
  items: 3,
  created: 1,
  updated: 1,
  unchanged: 0,
  deleted: 0,
  errors: [] as string[],
};

const ctxOutcome = (status: "complete" | "pending" | "failed") => ({
  status,
  scanned: status === "failed" ? null : 3,
  unitsCreated: status === "failed" ? null : 3,
  membershipsCreated: status === "failed" ? null : 3,
  cursor: status === "pending" ? "item-25" : null,
  error: status === "failed" ? "reconcile refused" : null,
  message: `CTX-${status}`,
});

beforeEach(() => {
  h.order.length = 0;
  h.requireTeamAdmin.mockReset().mockResolvedValue({ teamId: "team-1", memberId: "member-1" });
  h.revalidatePath.mockReset();
  for (const m of [h.runSlack, h.runPlane, h.runLinear, h.runGithub]) {
    m.mockReset().mockImplementation(async () => {
      h.order.push("import");
      return { ...cleanRun };
    });
  }
  h.runManualContextPass.mockReset().mockImplementation(async () => {
    h.order.push("context");
    return ctxOutcome("complete");
  });
});

describe.each(ENTRIES)("$name Run now — authorization gates everything", ({ action, runner }) => {
  it("a denied caller runs no import, no context pass and no revalidation", async () => {
    h.requireTeamAdmin.mockResolvedValue(null);

    const res = await action("acme");

    expect(res).toEqual({ ok: false, error: "admins only" });
    expect(runner()).not.toHaveBeenCalled();
    expect(h.runManualContextPass).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe.each(ENTRIES)("$name Run now — the context pass is wired (AC14-01/AC14-08)", ({ action, entrypoint }) => {
  it("reconciles exactly once, for this team, under its own entrypoint", async () => {
    await action("acme");
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(h.runManualContextPass).toHaveBeenCalledWith("team-1", entrypoint);
  });

  it("reconciles AFTER the import settles, and revalidates AFTER the context stage", async () => {
    await action("acme");
    expect(h.order).toEqual(["import", "context", "revalidate"]);
  });
});

describe.each(ENTRIES)("$name Run now — outcomes (AC14-04/AC14-05)", ({ action, runner }) => {
  it("clean import + complete context → ok:true, both messages preserved", async () => {
    const res = await action("acme");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("CTX-complete");
    expect(res.message, "the provider's own count message survives").toMatch(/\+1 new/);
    expect(res.error).toBeUndefined();
  });

  it("clean import + PENDING context → ok:false, leads with 'Import succeeded', names the remaining work", async () => {
    h.runManualContextPass.mockResolvedValue(ctxOutcome("pending"));

    const res = await action("acme");

    expect(res.ok, "{ok:true, message} would be invisible in the GitHub panel").toBe(false);
    expect(res.error).toMatch(/import succeeded/i);
    expect(res.error).toContain("CTX-pending");
    expect(h.revalidatePath).toHaveBeenCalledWith("/t/acme/admin/integrations");
  });

  it("clean import + FAILED context → ok:false with both halves", async () => {
    h.runManualContextPass.mockResolvedValue(ctxOutcome("failed"));
    const res = await action("acme");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("CTX-failed");
    expect(res.error).toMatch(/import succeeded/i);
  });

  it("a returned provider error still reconciles, keeps BOTH diagnostics, and revalidates", async () => {
    runner().mockImplementation(async () => {
      h.order.push("import");
      return { ...cleanRun, ok: false, errors: ["channel C1 is private"] };
    });

    const res = await action("acme");

    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("channel C1 is private");
    expect(res.error).toContain("CTX-complete");
    expect(res.error).not.toMatch(/import succeeded/i);
    expect(h.order).toEqual(["import", "context", "revalidate"]);
  });

  it("a THROWN provider still reconciles — a throw is not proof that nothing was written", async () => {
    runner().mockImplementation(async () => {
      h.order.push("import");
      throw new Error("socket hang up");
    });

    const res = await action("acme");

    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("socket hang up");
    expect(res.error).toContain("CTX-complete");
    expect(h.order).toEqual(["import", "context", "revalidate"]);
  });

  it("a SKIPPED provider is never reported as a successful import", async () => {
    runner().mockImplementation(async () => {
      h.order.push("import");
      return { ...cleanRun, created: 0, updated: 0, skipped: true };
    });

    const res = await action("acme");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/skipped|already running/i);
    expect(res.error).not.toMatch(/import succeeded/i);
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
  });

  it("a zero-change import is not a reason to skip reconciliation", async () => {
    runner().mockImplementation(async () => {
      h.order.push("import");
      return { ...cleanRun, created: 0, updated: 0, unchanged: 5 };
    });
    await action("acme");
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
  });
});

describe("preserved behaviour the wiring must not disturb", () => {
  it("GitHub still bypasses the watermark with force:true", async () => {
    await syncGithubNow("acme");
    expect(h.runGithub).toHaveBeenCalledWith({ teamId: "team-1", force: true });
  });

  it("Slack still revalidates on a failed run — a private-channel failure PURGES rows", async () => {
    h.runSlack.mockImplementation(async () => {
      h.order.push("import");
      return { ...cleanRun, ok: false, errors: ["channel C1 is private — purged"] };
    });
    await syncSlackNow("acme");
    expect(h.revalidatePath).toHaveBeenCalledWith("/t/acme/admin/integrations");
  });
});

describe("the two admin consumers this return shape is written for", () => {
  it("both render `error` on a failed result — which is why pending must be ok:false", () => {
    const manager = readFileSync("components/admin/integrations-manager.tsx", "utf8");
    const github = readFileSync("components/admin/github-repos-panel.tsx", "utf8");
    expect(manager).toMatch(/if \(!res\.ok\) setError\(res\.error/);
    expect(github).toMatch(/if \(!res\.ok\) setError\(res\.error/);
  });

  it("the GitHub panel's action runner reads no `message` at all", () => {
    const github = readFileSync("components/admin/github-repos-panel.tsx", "utf8");
    const act = github.slice(github.indexOf("function act("), github.indexOf("function connect("));
    expect(act.length, "the act() helper must still be findable").toBeGreaterThan(0);
    expect(act, "a success message is dropped on the floor here").not.toContain("res.message");
  });
});
