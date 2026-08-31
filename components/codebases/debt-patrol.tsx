import { ChevronRight } from "lucide-react";
import type {
  CodebaseFinding,
  FindingDecisionOwner,
} from "@/lib/metrics/codebases";
import type {
  DebtFactor,
  DebtPatrol as DebtPatrolModel,
} from "@/lib/codebases/debt-ranking";
import { FindingDecisionControl } from "@/components/codebases/finding-decision-control";

const DECISION_STATUSES = new Set([
  "accepted",
  "risk_accepted",
  "false_positive",
]);
const DISPLAY_LIMIT = 100;

function shortDate(value: string | null): string {
  if (!value) return "unknown";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function severityClass(severity: CodebaseFinding["severity"]): string {
  if (severity === "critical")
    return "border-red-400/40 bg-red-400/10 text-red-700 dark:text-red-300";
  if (severity === "high")
    return "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300";
  return "border-border-subtle bg-surface-raised text-ink-secondary";
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function FactorRow({ factor }: { factor: DebtFactor }) {
  return (
    <tr className="border-t border-border-subtle align-top">
      <th
        scope="row"
        className="px-2 py-2 text-left font-medium text-ink-secondary"
      >
        {factor.label}
        <span className="ml-1 font-normal text-ink-tertiary">
          · {factor.group}
        </span>
      </th>
      <td className="px-2 py-2 font-mono text-ink-secondary">
        {factor.state === "unknown" ? (
          <span className="rounded border border-amber-400/40 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
            unknown
          </span>
        ) : (
          `${factor.points}/${factor.weight}`
        )}
      </td>
      <td className="px-2 py-2 text-ink-secondary">
        <span className="font-medium text-ink">{factor.value}</span>
        <span className="mt-0.5 block text-ink-tertiary">
          {factor.explanation}
        </span>
      </td>
      <td className="px-2 py-2 text-ink-tertiary">
        {factor.provenance}
        <span className="block font-mono text-[10px]">
          {factor.verifierClass}
        </span>
      </td>
    </tr>
  );
}

function DecisionSummary({ finding }: { finding: CodebaseFinding }) {
  if (!DECISION_STATUSES.has(finding.status)) return null;
  return (
    <div className="border-l-2 border-amber-400 px-3 py-1.5 text-xs text-ink-secondary">
      <p>
        <span className="font-medium text-ink">
          {statusLabel(finding.status)}
        </span>{" "}
        by {finding.decision_by_member_name ?? "former member"}; owned by{" "}
        {finding.decision_owner_name ?? "former member"}; expires{" "}
        {shortDate(finding.decision_expires_at)}.
      </p>
      {finding.decision_reason ? (
        <p className="mt-1 text-ink-tertiary">{finding.decision_reason}</p>
      ) : null}
    </div>
  );
}

export function DebtPatrol({
  patrol,
  findings,
  decisionOwners,
  teamSlug,
  codebaseSlug,
  currentMemberId,
  canDecide,
}: {
  patrol: DebtPatrolModel;
  findings: CodebaseFinding[];
  decisionOwners: FindingDecisionOwner[];
  teamSlug: string;
  codebaseSlug: string;
  currentMemberId: string;
  canDecide: boolean;
}) {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const visibleRanked = patrol.ranked.slice(0, DISPLAY_LIMIT);
  const suppressedAll = findings.filter(
    (finding) =>
      DECISION_STATUSES.has(finding.status) &&
      !patrol.ranked.some((ranking) => ranking.findingId === finding.id),
  );
  const suppressed = suppressedAll.slice(0, DISPLAY_LIMIT);

  return (
    <section
      aria-labelledby="debt-patrol-heading"
      className="overflow-hidden rounded-lg border border-border-subtle"
    >
      <div className="border-b border-border-subtle px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
              Repository patrol · report only
            </p>
            <h2
              id="debt-patrol-heading"
              className="mt-1 font-display text-xl text-ink"
            >
              Explainable debt priority
            </h2>
            <p className="mt-1 max-w-3xl text-xs text-ink-secondary">
              Deterministic ranking of durable scanner findings. Unknown inputs
              remain unknown; this surface never writes source code, pull
              requests, or Linear issues.
            </p>
          </div>
          <span className="rounded-full border border-border-subtle px-2 py-1 font-mono text-[10px] text-ink-tertiary">
            method v{patrol.methodologyVersion}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 divide-x divide-border-subtle border-y border-border-subtle sm:grid-cols-4">
          {[
            ["Active", patrol.rollups.active],
            ["Recurring", patrol.rollups.recurring],
            ["Suppressed", patrol.rollups.suppressed],
            [
              "Ranking evidence coverage",
              patrol.rollups.admission.meanCoveragePct == null
                ? "n/a"
                : `${patrol.rollups.admission.meanCoveragePct}%`,
            ],
          ].map(([label, value]) => (
            <div key={label} className="px-3 py-2 first:pl-0 sm:first:pl-3">
              <dt className="text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
                {label}
              </dt>
              <dd className="mt-0.5 font-mono text-lg text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-ink-tertiary">
          Recurring counts a repeated scanner observation of the same
          fingerprint, not two distinct underlying defects.
        </p>
      </div>

      {patrol.ranked.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-secondary">
          No active durable findings in the latest admitted ledger state.
        </div>
      ) : (
        <ol className="divide-y divide-border-subtle">
          {visibleRanked.map((ranking) => {
            const finding = byId.get(ranking.findingId);
            if (!finding) return null;
            return (
              <li key={finding.id} className="px-4 py-4 sm:px-5">
                <article aria-labelledby={`finding-${finding.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-ink-tertiary">
                          #{ranking.rank}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${severityClass(finding.severity)}`}
                        >
                          {finding.severity}
                        </span>
                        <span className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-ink-tertiary">
                          {statusLabel(ranking.effectiveStatus)}
                        </span>
                        {ranking.decisionExpired ? (
                          <span className="rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                            decision expired · re-entered
                          </span>
                        ) : null}
                      </div>
                      <h3
                        id={`finding-${finding.id}`}
                        className="mt-2 font-mono text-sm font-medium text-ink"
                      >
                        {finding.check_id}
                      </h3>
                      <p className="mt-0.5 text-xs text-ink-tertiary">
                        {finding.axis} · {statusLabel(finding.kind)} · observed{" "}
                        {finding.occurrence_count}× · first seen{" "}
                        {shortDate(finding.first_seen_at)}
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-x-4 text-right">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-ink-tertiary">
                          Priority
                        </p>
                        <p className="font-mono text-xl text-ink">
                          {ranking.priorityScore}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-ink-tertiary">
                          Principal
                        </p>
                        <p className="font-mono text-sm text-ink-secondary">
                          {ranking.principalScore}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-ink-tertiary">
                          Interest
                        </p>
                        <p className="font-mono text-sm text-ink-secondary">
                          {ranking.interestScore}
                        </p>
                      </div>
                    </div>
                  </div>

                  <p className="mt-2 font-mono text-[10px] text-ink-tertiary">
                    fingerprint {finding.fingerprint} · ranking evidence{" "}
                    {ranking.scoreCoveragePct}%
                  </p>
                  <DecisionSummary finding={finding} />

                  <details className="group/rank mt-3">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50">
                      <ChevronRight className="size-3 transition-transform group-open/rank:rotate-90" />
                      Why this rank
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="min-w-[720px] w-full text-xs">
                        <thead className="text-left text-[10px] uppercase tracking-wide text-ink-tertiary">
                          <tr>
                            <th className="px-2 py-1 font-medium">Factor</th>
                            <th className="px-2 py-1 font-medium">Points</th>
                            <th className="px-2 py-1 font-medium">
                              Interpretation
                            </th>
                            <th className="px-2 py-1 font-medium">
                              Provenance
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {ranking.factors.map((factor) => (
                            <FactorRow key={factor.key} factor={factor} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details className="group/history mt-3">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50">
                      <ChevronRight className="size-3 transition-transform group-open/history:rotate-90" />
                      Lifecycle history ({finding.events.length})
                    </summary>
                    <ol className="mt-2 border-l border-border-subtle pl-3 text-xs">
                      {finding.events.map((event) => (
                        <li
                          key={event.id}
                          className="py-1.5 text-ink-secondary"
                        >
                          <span className="font-medium text-ink">
                            {statusLabel(event.event_type)}
                          </span>{" "}
                          <span className="text-ink-tertiary">
                            {shortDate(event.observed_at)} ·{" "}
                            {event.from_status
                              ? `${statusLabel(event.from_status)} → `
                              : ""}
                            {statusLabel(event.to_status)} · head{" "}
                            {event.head_sha.slice(0, 8)}
                          </span>
                          {typeof event.details.reason === "string" ? (
                            <span className="mt-0.5 block text-ink-tertiary">
                              {event.details.reason}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </details>

                  {canDecide ? (
                    <div className="mt-3">
                      <FindingDecisionControl
                        teamSlug={teamSlug}
                        codebaseSlug={codebaseSlug}
                        findingId={finding.id}
                        owners={decisionOwners}
                        currentMemberId={currentMemberId}
                        existingOwnerId={finding.decision_owner_member_id}
                      />
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      )}

      {patrol.ranked.length > visibleRanked.length ? (
        <p className="border-t border-border-subtle px-5 py-3 text-xs text-ink-tertiary">
          Showing the top {visibleRanked.length} of {patrol.ranked.length}{" "}
          active findings; all findings remain included in rollups.
        </p>
      ) : null}

      {suppressedAll.length > 0 ? (
        <details className="group/suppressed border-t border-border-subtle px-4 py-3 sm:px-5">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50">
            <ChevronRight className="size-3 transition-transform group-open/suppressed:rotate-90" />
            Current operator decisions ({suppressedAll.length})
          </summary>
          <div className="mt-3 grid gap-3">
            {suppressed.map((finding) => (
              <div
                key={finding.id}
                className="grid gap-2 border-t border-border-subtle pt-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div>
                  <p className="font-mono text-xs text-ink">
                    {finding.check_id}
                  </p>
                  <DecisionSummary finding={finding} />
                </div>
                {canDecide ? (
                  <FindingDecisionControl
                    teamSlug={teamSlug}
                    codebaseSlug={codebaseSlug}
                    findingId={finding.id}
                    owners={decisionOwners}
                    currentMemberId={currentMemberId}
                    existingOwnerId={finding.decision_owner_member_id}
                  />
                ) : null}
              </div>
            ))}
            {suppressedAll.length > suppressed.length ? (
              <p className="text-xs text-ink-tertiary">
                Showing {suppressed.length} of {suppressedAll.length} current
                decisions.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <details className="group/northstar border-t border-border-subtle px-4 py-3 sm:px-5">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50">
          <ChevronRight className="size-3 transition-transform group-open/northstar:rotate-90" />
          North Star reconciliation and admission gaps
        </summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <dl className="divide-y divide-border-subtle border-y border-border-subtle">
            {patrol.rollups.northStar.map((metric) => (
              <div
                key={metric.key}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2 text-xs"
              >
                <div>
                  <dt className="font-medium text-ink">{metric.label}</dt>
                  <dd className="text-ink-tertiary">{metric.explanation}</dd>
                </div>
                <dd className="text-right font-mono text-ink-secondary">
                  {metric.value ?? "unknown"}
                  <span className="block text-[10px] text-ink-tertiary">
                    {metric.unit}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <div className="text-xs text-ink-secondary">
            <p className="font-medium text-ink">Operational rollups</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              {[
                ["Recurring", patrol.rollups.recurring],
                ["Evidence incomplete", patrol.rollups.evidenceUnknown],
                ["Expired decisions", patrol.rollups.expired],
                ["Age 0–7d", patrol.rollups.age.fresh],
                ["Age 8–30d", patrol.rollups.age.established],
                ["Age 31–90d", patrol.rollups.age.aging],
                ["Age 90d+", patrol.rollups.age.entrenched],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex justify-between border-b border-border-subtle pb-1"
                >
                  <dt>{label}</dt>
                  <dd className="font-mono">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 font-medium text-ink">Stored lifecycle</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              {Object.entries(patrol.rollups.lifecycle)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => (
                  <div
                    key={status}
                    className="flex justify-between border-b border-border-subtle pb-1"
                  >
                    <dt>{statusLabel(status)}</dt>
                    <dd className="font-mono">{count}</dd>
                  </div>
                ))}
            </dl>
            <p className="mt-4 font-medium text-ink">
              Unknown factor admission
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
              {Object.entries(patrol.rollups.admission.unknownFactors).map(
                ([key, count]) => (
                  <div
                    key={key}
                    className="flex justify-between border-b border-border-subtle pb-1"
                  >
                    <dt>{statusLabel(key)}</dt>
                    <dd className="font-mono">{count}</dd>
                  </div>
                ),
              )}
            </dl>
            <p className="mt-3 text-ink-tertiary">
              The verified hardening-efficacy and cost report remains in the
              engineering harness; these repository rollups do not replace it.
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}
