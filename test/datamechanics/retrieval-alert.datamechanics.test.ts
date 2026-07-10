import { describe, expect, it } from "vitest";
import { lastDenseRunFailed } from "@/lib/query/retrieval-alert";
import { recordIngestRun } from "@/lib/ingest/runs";
import { db } from "./helpers";

// Spec: lastDenseRunFailed reflects the MOST RECENT dense run's outcome — the edge-detection that
// makes the degraded-email debounced (fire once on ok→degraded, not every tick). Verified on real
// Postgres via the real recordIngestRun writer.

const t = (iso: string) => Date.parse(iso);

describe("lastDenseRunFailed (dense-leg edge detection)", () => {
  it("false when there are no dense runs", async () => {
    expect(await lastDenseRunFailed(db())).toBe(false);
  });

  it("tracks the newest dense run's ok flag as it flips", async () => {
    await recordIngestRun(db(), { source: "dense", trigger: "scheduler", ok: true, startedAt: t("2026-07-09T10:00:00Z"), finishedAt: t("2026-07-09T10:00:01Z") });
    expect(await lastDenseRunFailed(db())).toBe(false);

    await recordIngestRun(db(), { source: "dense", trigger: "scheduler", ok: false, errors: ["quota"], startedAt: t("2026-07-09T10:30:00Z"), finishedAt: t("2026-07-09T10:30:01Z") });
    expect(await lastDenseRunFailed(db())).toBe(true); // degraded now

    await recordIngestRun(db(), { source: "dense", trigger: "scheduler", ok: true, startedAt: t("2026-07-09T11:00:00Z"), finishedAt: t("2026-07-09T11:00:01Z") });
    expect(await lastDenseRunFailed(db())).toBe(false); // recovered
  });

  it("ignores other sources — a failed Slack run doesn't read as a dense failure", async () => {
    await recordIngestRun(db(), { source: "dense", trigger: "scheduler", ok: true, startedAt: t("2026-07-09T10:00:00Z"), finishedAt: t("2026-07-09T10:00:01Z") });
    await recordIngestRun(db(), { source: "slack", trigger: "scheduler", ok: false, errors: ["boom"], startedAt: t("2026-07-09T12:00:00Z"), finishedAt: t("2026-07-09T12:00:01Z") });
    expect(await lastDenseRunFailed(db())).toBe(false); // the dense leg is still healthy
  });
});
