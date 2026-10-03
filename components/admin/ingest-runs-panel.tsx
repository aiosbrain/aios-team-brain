import { relativeAge } from "@/lib/ingest/runs-format";
import type { IngestRunRow } from "@/lib/ingest/runs";
import { decodeBootstrapEvidence, type AccessBootstrapEvidence, type BootstrapPhaseError } from "@/lib/access/bootstrap-evidence";

/**
 * Admin → Integrations "Recent ingestion runs" panel. Read-only view of the `ingest_runs` log so
 * import/scan failures are diagnosable (this is the surface that turns a silent breakage into a
 * visible one). Server component: the page passes rows it already gated on (admin-only) — and since
 * AUDITFIX-25 a failed `access_bootstrap` row also discloses its bounded evidence here, that page
 * gate is what keeps these rows out of a non-admin's HTML and RSC payload.
 */
export function IngestRunsPanel({ runs }: { runs: IngestRunRow[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-inset px-3 py-2 text-sm text-ink-secondary">
        No ingestion runs recorded yet. Scheduler ticks, manual <code>/sync</code> runs, and codebase
        scans will appear here with their outcome and any errors.
      </div>
    );
  }

  return (
    // A horizontal SCROLL region, not a clip: six columns do not fit a narrow viewport, and clipping
    // them put the Details column (and its Evidence toggle) out of reach. It is labelled and
    // focusable so a keyboard can scroll it too — one extra tab stop, before the first summary.
    // It is also the inline-size query container the Details box below is capped against: the
    // region's real width comes from its parent (a fixed sidebar leaves far less than the viewport).
    // `outline-hidden`, not `outline-none`: the ring is a box-shadow, which forced colors drops.
    <div
      role="region"
      aria-label="Recent runs"
      tabIndex={0}
      className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-border-subtle outline-hidden [container-type:inline-size] focus-visible:border-violet focus-visible:ring-2 focus-visible:ring-violet/40"
    >
      <table className="w-full text-sm">
        <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Trigger</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Changes</th>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const when = new Date(r.finished_at).getTime();
            const changes = `+${r.created} ~${r.updated}${r.unchanged ? ` =${r.unchanged}` : ""}`;
            // AUDITFIX-25: non-null only for a recognized version-1 envelope on a FAILED, team-owned
            // `access_bootstrap` row whose envelope names that same team. Everything else — older
            // rows, other sources, `team_id is null` rows, malformed/oversized/future metadata —
            // decodes to null and keeps exactly the presentation it had.
            const evidence = decodeBootstrapEvidence(r);
            return (
              <tr key={r.id} className="border-t border-border-subtle align-top">
                <td className="px-3 py-2 font-medium text-ink">{r.source}</td>
                <td className="px-3 py-2 text-ink-secondary">{r.trigger}</td>
                <td className="px-3 py-2">
                  {r.ok ? (
                    <span className="rounded-full bg-emerald/10 px-2 py-0.5 text-xs font-medium text-emerald">
                      ok
                    </span>
                  ) : (
                    <span className="rounded-full bg-red/10 px-2 py-0.5 text-xs font-medium text-red">
                      failed{r.error_count ? ` (${r.error_count})` : ""}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-ink-secondary">{changes}</td>
                <td className="px-3 py-2 whitespace-nowrap text-ink-secondary" title={r.finished_at}>
                  {relativeAge(when)}
                </td>
                <td className="px-3 py-2 text-ink-tertiary">
                  {/* One BOUNDED box for everything in this cell. An unbroken label, reason or JSON
                      value otherwise sets the column's minimum width and the table grows with it;
                      here it wraps anywhere instead — the text is all still there, never cut. 20rem
                      where there is room, capped by the scroll region's own width (`cqw`), not the
                      viewport's: a 20rem summary inside a narrower region scrolls its own label away. */}
                  <div className="w-80 min-w-0 max-w-[calc(100cqw-1rem)] [overflow-wrap:anywhere]">
                    {r.errors.length > 0 ? (
                      <span className="text-red" title={r.errors.join("\n")}>
                        {r.errors[0].slice(0, 120)}
                        {r.errors[0].length > 120 ? "…" : ""}
                      </span>
                    ) : (
                      <RunMeta meta={r.meta} />
                    )}
                    {/* BESIDE the error, not instead of it: a failed row's metadata is otherwise never
                        rendered (the ternary above), which is right for arbitrary meta and was the
                        reason the one row with something to disclose showed none of it. */}
                    {evidence ? <BootstrapEvidenceDisclosure evidence={evidence} /> : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Render the small set of meta keys we record, compactly. */
/** Objects/arrays render as compact JSON — `String(v)` printed `[object Object]` for
 *  `partialDetail`, and GRAPHSAT-1's `deepRequeueSample` is a list of structured identities. */
export function formatMetaValue(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

function RunMeta({ meta }: { meta: Record<string, unknown> }) {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${formatMetaValue(v)}`);
  return <span>{parts.join(" · ") || "—"}</span>;
}

/**
 * AUDITFIX-25 — the bounded bootstrap evidence of one failed team row, behind a native `<details>`
 * that is CLOSED by default (no client component: the browser owns expand/collapse and its keyboard
 * handling). A read surface only — it repairs nothing and composes no command.
 *
 * It receives the DECODED projection, never the row's raw metadata, so the only values rendered are
 * the validated known fields. Every string is React text. Slugs and messages are attacker-influenced
 * and sit next to identifiers an operator will copy, so each is wrapped in its own `<bdi>`: a
 * direction override inside a label cannot reorder the UUID beside it.
 *
 * What it must keep saying: the count is exact but the list is a SAMPLE; an unreadable census is
 * unavailable, never zero; and a shortened label or message is marked as shortened. The sample
 * heading is truthful both ways: with nothing omitted it IS every finding of that tick (not of the
 * current state — a later read sees a newer snapshot), otherwise it is not the complete set.
 *
 * Long labels and reasons WRAP (`overflow-wrap: anywhere`, every level shrinkable); nothing here is
 * clamped, ellipsized or hidden to make it fit.
 */
function BootstrapEvidenceDisclosure({ evidence }: { evidence: AccessBootstrapEvidence }) {
  const { convergence, census, sample, omitted } = evidence;
  return (
    <details className="mt-1 min-w-0 max-w-full text-xs text-ink-secondary">
      <summary className="cursor-pointer text-ink-tertiary">Evidence</summary>
      <div className="mt-1 flex min-w-0 max-w-full flex-col gap-1 [overflow-wrap:anywhere]">
        <p>
          <span className="font-medium text-ink">Convergence:</span> {convergence.status}
          {convergence.error ? <PhaseErrorText error={convergence.error} /> : null}
        </p>
        <p>
          <span className="font-medium text-ink">Census:</span>{" "}
          {census.total === null
            ? "failed · finding count unavailable"
            : `complete · ${census.total} unsanctioned ${census.total === 1 ? "edge" : "edges"} · ${sample.length} sampled · ${omitted} omitted`}
          {census.error ? <PhaseErrorText error={census.error} /> : null}
        </p>
        {sample.length > 0 ? (
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {`Sample — ${sample.length} of ${census.total}, ${omitted === 0 ? "all findings for this tick" : "not the complete set"}`}
            </p>
            <ul className="mt-0.5 flex min-w-0 flex-col gap-1">
              {sample.map((s, i) => (
                // Index key: findings are not deduplicated, so two samples can share both ids.
                <li key={i} className="flex min-w-0 flex-col">
                  <SampleIdentity kind="project" slug={s.projectSlug} truncated={s.projectSlugTruncated} id={s.projectId} />
                  <SampleIdentity kind="group" slug={s.groupSlug} truncated={s.groupSlugTruncated} id={s.groupId} />
                </li>
              ))}
            </ul>
            <p className="mt-0.5 text-ink-tertiary">Names are display labels and may be shortened; the IDs are exact.</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function PhaseErrorText({ error }: { error: BootstrapPhaseError }) {
  return (
    <>
      {" — "}
      <bdi>{error.message}</bdi>
      {error.truncated ? <span className="text-ink-tertiary"> (shortened)</span> : null}
    </>
  );
}

function SampleIdentity({ kind, slug, truncated, id }: { kind: "project" | "group"; slug: string; truncated: boolean; id: string }) {
  return (
    <span className="min-w-0">
      {kind} <bdi className="text-ink">{slug}</bdi>
      {truncated ? <span className="text-ink-tertiary"> (label shortened)</span> : null}{" "}
      <code className="break-all font-mono text-ink-tertiary">{id}</code>
    </span>
  );
}
