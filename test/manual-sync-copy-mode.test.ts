import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AC-07 through the ACTUAL manual ingestion callers, on a copied staging deployment.
 *
 * Why this file exists as well as `test/staging-query-no-spend.test.ts`: the no-spend policy answers
 * "may this deployment call a model", and a connector import calls none. Nothing in it refuses a
 * Slack token, and since AUDITFIX-14 a manual entrypoint is `import → ONE bounded project-context
 * pass → revalidate`, with the context stage deliberately NOT conditional on the import succeeding.
 * A per-leg refusal would therefore have become the *trigger* for the rest of a disabled operation.
 *
 * So the assertions here are about the WHOLE operation, driven through `runManualSync` and the four
 * real admin actions rather than through a helper:
 *
 *   • denied ⇒ zero connector legs, zero Linear inbound, zero context pass, zero ingest-run ledger
 *     rows, zero revalidation — and a named result, not a thrown error;
 *   • the mode read is the real one (`readStagingRuntimeState`) and fails CLOSED: a pinned staging
 *     deployment whose marker/journal cannot be read is denied, not allowed;
 *   • forced `INGEST_POLL_ENABLED=true` and configured provider keys do not defeat it;
 *   • POSITIVE CONTROL — in production mode every stage still runs, including the #698 rule that a
 *     THROWN connector leg still reconciles. Without this pair a guard that simply broke manual sync
 *     everywhere would look identical to a correct one.
 */

const h = vi.hoisted(() => ({
  requireTeamAdmin: vi.fn(),
  runSlack: vi.fn(),
  runPlane: vi.fn(),
  runLinear: vi.fn(),
  runGithub: vi.fn(),
  runLinearInbound: vi.fn(),
  runManualContextPass: vi.fn(),
  recordIngestRun: vi.fn(),
  revalidatePath: vi.fn(),
  /** M3: the manual graph entrypoint's runner, so "it never started" is observable. */
  runGraphProjection: vi.fn(),
  /** The DB seam UNDER the policy: the real policy module runs on top of these two reads. */
  readStagingMarker: vi.fn(),
  runSql: vi.fn(),
}));

vi.mock("@/lib/env/staging-marker", () => ({ readStagingMarker: h.readStagingMarker }));
vi.mock("@/lib/db/pg/pool", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runSql: h.runSql,
}));

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: h.requireTeamAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/ingest/run", () => ({
  runSlackIngestion: h.runSlack,
  runPlaneIngestion: h.runPlane,
  runLinearIngestion: h.runLinear,
  runGithubIngestion: h.runGithub,
}));
vi.mock("@/lib/pm-sync/inbound", () => ({ runLinearInbound: h.runLinearInbound }));
vi.mock("@/lib/ingest/runs", () => ({ recordIngestRun: h.recordIngestRun }));
vi.mock("@/lib/ingest/manual-context", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runManualContextPass: h.runManualContextPass,
}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({ from: vi.fn() }) }));

// Unrelated dependencies of `actions.ts`, which this file imports for its four real "Run now" actions.
// `runGraphProjection` is NOT unrelated any more: `projectToGraphNow` below asserts it never starts.
vi.mock("@/lib/graph/run", () => ({ runGraphProjection: h.runGraphProjection }));
vi.mock("@/lib/graph/projection-run", () => ({
  projectionRunInput: vi.fn(),
  shouldRecordProjectionRun: vi.fn(() => false),
}));
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

import { runManualSync } from "@/lib/ingest/manual-sync";
import { INGEST_DISABLED_CODE, INGEST_DISABLED_MESSAGE, manualIngestionVerdict } from "@/lib/staging/ingest-policy";
import {
  projectToGraphNow,
  syncGithubNow,
  syncLinearNow,
  syncPlaneNow,
  syncSlackNow,
} from "@/app/t/[team]/admin/integrations/actions";

type Action = (slug: string) => Promise<{ ok: boolean; error?: string; message?: string }>;

const ACTIONS: { name: string; action: Action; runner: () => ReturnType<typeof vi.fn> }[] = [
  { name: "slack", action: syncSlackNow, runner: () => h.runSlack },
  { name: "plane", action: syncPlaneNow, runner: () => h.runPlane },
  { name: "linear", action: syncLinearNow, runner: () => h.runLinear },
  { name: "github", action: syncGithubNow, runner: () => h.runGithub },
];

const cleanRun = {
  ok: true,
  integrations: 1,
  channels: 1,
  projects: 1,
  items: 1,
  created: 1,
  updated: 0,
  unchanged: 0,
  errors: [] as string[],
};

const STAGING_ENV_KEYS = [
  "STAGING_DATA_MODE",
  "STAGING_OPS_ENVIRONMENT_ID",
  "RAILWAY_ENVIRONMENT_ID",
  "INGEST_POLL_ENABLED",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

/** Every connector/ledger/reconcile call the disabled operation must not make. */
const allWorkMocks = () => [
  h.runSlack,
  h.runPlane,
  h.runLinear,
  h.runGithub,
  h.runLinearInbound,
  h.runManualContextPass,
  h.recordIngestRun,
  h.revalidatePath,
];

function expectNoWorkAtAll(label: string) {
  for (const m of allWorkMocks()) expect(m, `${label}: nothing may run`).not.toHaveBeenCalled();
}

/** A ready copied-staging journal row — the state a live copy-mode deployment actually reports. */
function copyReadyDeployment() {
  process.env.STAGING_DATA_MODE = "copy-ready";
  h.readStagingMarker.mockResolvedValue(true);
  h.runSql.mockResolvedValue({
    rows: [{ run_id: "run-7", state: "ready", catchup_commit: null, last_ready_mode: "copy-ready", candidate_mode: "copy-ready" }],
  });
}

/** An ordinary production deployment: no marker, no staging env, no journal. */
function productionDeployment() {
  h.readStagingMarker.mockResolvedValue(false);
  h.runSql.mockRejectedValue(new Error("staging_ops.refresh_journal does not exist"));
}

beforeEach(() => {
  for (const k of STAGING_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  h.requireTeamAdmin.mockReset().mockResolvedValue({ teamId: "team-1", memberId: "member-1" });
  h.revalidatePath.mockReset();
  for (const m of [h.runSlack, h.runPlane, h.runLinear, h.runGithub]) {
    m.mockReset().mockResolvedValue({ ...cleanRun });
  }
  h.runLinearInbound.mockReset().mockResolvedValue({
    ok: true,
    teams: 1,
    applied: 0,
    adopted: 0,
    noops: 0,
    conflicts: 0,
    errors: [],
    skipped: false,
    skippedReasons: [],
  });
  h.recordIngestRun.mockReset().mockResolvedValue(undefined);
  h.runManualContextPass.mockReset().mockResolvedValue({
    status: "complete",
    scanned: 2,
    unitsCreated: 2,
    membershipsCreated: 2,
    cursor: null,
    error: null,
    message: "CTX-complete",
  });
  h.readStagingMarker.mockReset();
  h.runSql.mockReset();
  h.runGraphProjection.mockReset();
});

afterEach(() => {
  for (const k of STAGING_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("manualIngestionVerdict — the mode read, fail-closed", () => {
  it("allows an ordinary production deployment", async () => {
    productionDeployment();
    expect(await manualIngestionVerdict()).toEqual({ allowed: true, code: null, message: null });
  });

  it("denies a ready copied-staging deployment", async () => {
    copyReadyDeployment();
    const v = await manualIngestionVerdict();
    expect(v.allowed).toBe(false);
    expect(v.code).toBe(INGEST_DISABLED_CODE);
    expect(v.message).toBe(INGEST_DISABLED_MESSAGE);
  });

  it("denies a PINNED staging deployment whose marker cannot be read", async () => {
    // Fail-closed: an unreadable mode is not permission. This is the case an env-only check misses.
    process.env.STAGING_OPS_ENVIRONMENT_ID = "env-staging";
    process.env.RAILWAY_ENVIRONMENT_ID = "env-staging";
    h.readStagingMarker.mockRejectedValue(new Error("connection refused"));
    expect((await manualIngestionVerdict()).allowed).toBe(false);
  });

  it("denies a declared copy deployment whose journal read fails", async () => {
    process.env.STAGING_DATA_MODE = "copy-ready";
    h.readStagingMarker.mockResolvedValue(true);
    h.runSql.mockRejectedValue(new Error("permission denied for schema staging_ops"));
    expect((await manualIngestionVerdict()).allowed).toBe(false);
  });

  it("is not defeated by forced poll flags or configured provider keys", async () => {
    copyReadyDeployment();
    process.env.INGEST_POLL_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-forced";
    process.env.ANTHROPIC_API_KEY = "sk-ant-forced";
    expect((await manualIngestionVerdict()).allowed).toBe(false);
  });
});

describe("runManualSync on a copied staging deployment", () => {
  it("refuses the WHOLE operation: no leg, no inbound, no context pass, no ledger row", async () => {
    copyReadyDeployment();

    const r = await runManualSync("team-1");

    expectNoWorkAtAll("chat /sync");
    expect(r.refused).toBe(true);
    expect(r.summary).toContain(INGEST_DISABLED_MESSAGE);
    expect(r.summary).not.toContain("Scrape complete");
    expect({ created: r.created, updated: r.updated, errors: r.errors }).toEqual({ created: 0, updated: 0, errors: 0 });
  });

  it("refuses with forced poll flags and provider keys present", async () => {
    copyReadyDeployment();
    process.env.INGEST_POLL_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-forced";

    const r = await runManualSync("team-1");

    expectNoWorkAtAll("chat /sync with forced flags");
    expect(r.refused).toBe(true);
  });

  it("refuses when the pinned deployment's mode cannot be read (fail-closed)", async () => {
    process.env.STAGING_OPS_ENVIRONMENT_ID = "env-staging";
    process.env.RAILWAY_ENVIRONMENT_ID = "env-staging";
    h.readStagingMarker.mockRejectedValue(new Error("connection refused"));

    const r = await runManualSync("team-1");

    expectNoWorkAtAll("chat /sync, unreadable mode");
    expect(r.refused).toBe(true);
  });

  // POSITIVE CONTROL: the guard must not be indistinguishable from "manual sync is broken".
  it("PRODUCTION: still runs every leg and exactly one context pass", async () => {
    productionDeployment();

    const r = await runManualSync("team-1");

    for (const m of [h.runSlack, h.runPlane, h.runLinear, h.runGithub]) expect(m).toHaveBeenCalledTimes(1);
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(h.runManualContextPass).toHaveBeenCalledWith("team-1", "manual_sync");
    expect(r.refused).toBeUndefined();
    expect(r.summary).toContain("CTX-complete");
  });

  // #698's rule, preserved: a THROWN leg is not evidence that nothing was committed, so production
  // still reconciles. This is the exact behaviour the copy-mode gate must pre-empt rather than reuse.
  it("PRODUCTION: a thrown connector leg still reconciles", async () => {
    productionDeployment();
    h.runSlack.mockRejectedValue(new Error("slack 500"));

    const r = await runManualSync("team-1");

    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("slack 500");
  });
});

/**
 * M3 — the MANUAL graph entrypoint, gated at the same policy as the runner.
 *
 * `runGraphProjection` refuses on its own, so this is not the only gate. It is a distinct one: a
 * button that returned "refused" out of the runner would still have opened an `ingest_runs` row on a
 * copied instance and told the admin nothing useful. The ordering claim — authorization, THEN the
 * runtime policy, THEN any run accounting — is what these three rows pin.
 */
describe("projectToGraphNow on a copied staging deployment", () => {
  for (const mode of ["copy-ready", "copy-safe-refusal"] as const) {
    const arrange = mode === "copy-ready"
      ? copyReadyDeployment
      : () => {
        // The posture could not be ESTABLISHED — a pinned deployment whose journal read fails.
        // Distinct from `copy-ready` because an unestablished posture is not permission.
        process.env.STAGING_OPS_ENVIRONMENT_ID = "env-staging";
        process.env.RAILWAY_ENVIRONMENT_ID = "env-staging";
        h.readStagingMarker.mockRejectedValue(new Error("connection refused"));
      };

    it(`refuses a ${mode} runtime after authorization, starting no projection and no run accounting`, async () => {
      arrange();

      const res = await projectToGraphNow("acme");

      expect(res.ok).toBe(false);
      expect(res.error, "the refusal must name the runtime, not a generic failure").toContain(mode);
      expect(res.message).toBeUndefined();
      expect(h.runGraphProjection, "the projection run started anyway").not.toHaveBeenCalled();
      expect(h.recordIngestRun, "a refused click still opened an ingest_runs row").not.toHaveBeenCalled();
      expect(h.revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("answers an UNAUTHORIZED caller as unauthorized, without disclosing the runtime posture", async () => {
    // Authorization is answered FIRST, deliberately: "admins only" is the answer to a non-admin
    // whatever the runtime is, and telling a stranger which mode this deployment is in is not this
    // function's job.
    copyReadyDeployment();
    h.requireTeamAdmin.mockResolvedValue(null);

    const res = await projectToGraphNow("acme");

    expect(res).toEqual({ ok: false, error: "admins only" });
    expect(h.runGraphProjection).not.toHaveBeenCalled();
  });

  it("PRODUCTION: still runs the projection and revalidates", async () => {
    // The positive control. Without it, a gate that broke the button everywhere would look identical.
    productionDeployment();
    h.runGraphProjection.mockResolvedValue({
      ok: true, configured: true, projected: 2, episodes: 3, skipped: 1, scanned: 4,
      lockedOut: 0, errors: [],
    });

    const res = await projectToGraphNow("acme");

    expect(h.runGraphProjection).toHaveBeenCalledTimes(1);
    expect(h.runGraphProjection).toHaveBeenCalledWith({ teamId: "team-1" });
    expect(res.ok).toBe(true);
    expect(h.revalidatePath).toHaveBeenCalledWith("/t/acme/admin/integrations");
  });
});

describe.each(ACTIONS)("$name Run now on a copied staging deployment", ({ action, runner }) => {
  it("refuses after authorization, importing and reconciling nothing", async () => {
    copyReadyDeployment();

    const res = await action("acme");

    expect(res.ok).toBe(false);
    expect(res.error).toBe(INGEST_DISABLED_MESSAGE);
    expect(res.message).toBeUndefined();
    expect(runner()).not.toHaveBeenCalled();
    expect(h.runManualContextPass).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("still refuses an UNAUTHORIZED caller as unauthorized, doing nothing", async () => {
    // The negative control #698 shipped: authorization is answered first, so the refusal message
    // never tells a stranger which mode this deployment is in.
    copyReadyDeployment();
    h.requireTeamAdmin.mockResolvedValue(null);

    const res = await action("acme");

    expect(res).toEqual({ ok: false, error: "admins only" });
    expectNoWorkAtAll("unauthorized in copy mode");
  });

  it("PRODUCTION: imports, reconciles once and revalidates", async () => {
    productionDeployment();

    const res = await action("acme");

    expect(runner()).toHaveBeenCalledTimes(1);
    expect(h.runManualContextPass).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/t/acme/admin/integrations");
    expect(res.ok).toBe(true);
  });
});
