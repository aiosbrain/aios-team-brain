/**
 * Admin → Integrations: what the Google Drive "Coordinator status" line says (AIO-1167 AC-07).
 *
 * Pure and client-safe — the component renders it, the page supplies the rows, and the unit test
 * pins every branch. Three DIFFERENT facts are kept apart, because conflating them is how the panel
 * used to mislead:
 *
 *   · the latest ATTEMPT  — the newest report of any kind, a busy deferral or a queued request
 *                           included. It says when the coordinator last tried, and how that ended.
 *   · the latest REPORT   — the newest run that did work (complete / partial / failed). Counts,
 *                           backlog and cursor age come from here: a busy deferral carries zero
 *                           counters and an UNKNOWN backlog, and must never read as "backlog 0".
 *   · the latest SUCCESS  — the newest authoritative complete run, read independently per connection
 *                           (`listGdriveRunStatus`), never inferred from a recent page of attempts.
 *
 * And the connection's CURRENT state comes first: a paused or disconnected connection says so ahead
 * of any historical run, which is then labelled as history.
 */
export interface GdriveRunRow {
  id: string;
  integration_id: string;
  trigger: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary: Record<string, unknown>;
  error: string | null;
}

export interface GdriveRunStatus {
  latestAttempt: GdriveRunRow | null;
  latestReport: GdriveRunRow | null;
  latestSuccess: GdriveRunRow | null;
}

const at = (row: GdriveRunRow, prefer: "started" | "finished"): string => {
  const value = prefer === "started"
    ? row.started_at ?? row.created_at
    : row.finished_at ?? row.created_at;
  return new Date(value).toLocaleString();
};

const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The status lines, in render order. */
export function describeGdriveCoordinator(input: {
  /** `enabled` / `disabled`, or null when no Drive connection exists. */
  integrationStatus: string | null;
  status: GdriveRunStatus | null;
}): string[] {
  if (input.integrationStatus === null) return ["Connect Google Drive to begin reporting runs."];
  const lines: string[] = [];
  const paused = input.integrationStatus !== "enabled";
  if (paused) lines.push("Paused or disconnected; no work will be claimed.");
  const status = input.status ?? { latestAttempt: null, latestReport: null, latestSuccess: null };
  const { latestAttempt, latestReport, latestSuccess } = status;
  if (!latestAttempt) {
    if (!paused) lines.push("No coordinator attempt has been reported yet. Backlog and cursor age are unknown.");
    return lines;
  }
  const history = paused ? "Before the pause: " : "";
  lines.push(
    `${history}last attempt ${latestAttempt.trigger} · ${latestAttempt.status} · ${at(latestAttempt, "started")}`
      + (latestAttempt.error ? ` · ${latestAttempt.error}` : ""),
  );
  lines.push(latestSuccess
    ? `Last proven complete success ${at(latestSuccess, "finished")}`
    : "No proven complete success");
  if (!latestReport) {
    lines.push("No run has reported progress yet · backlog unknown · cursor age unknown");
    return lines;
  }
  const s = latestReport.summary;
  const n = (key: string) => (known(s[key]) ? s[key] : 0);
  lines.push(
    `Latest progress (${latestReport.status}, ${at(latestReport, "finished")}): `
      + `${n("created")} created, ${n("updated")} updated, ${n("unchanged")} unchanged, `
      + `${n("removed")} removed, ${n("skipped")} skipped, ${n("failed")} failed`
      + (known(s.backlog) ? ` · backlog ${s.backlog}` : " · backlog unknown")
      + (known(s.cursorAgeSeconds) ? ` · cursor age ${Math.round(s.cursorAgeSeconds)}s` : " · cursor age unknown"),
  );
  return lines;
}
