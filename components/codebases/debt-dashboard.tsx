import type {
  CodebaseDebtKpis,
  FixAgeBucket,
  OpenAgeBucket,
} from "@/lib/codebases/debt-kpis";

const OPEN_AGE_LABELS: Array<[OpenAgeBucket, string]> = [
  ["0_7d", "0–7d"],
  ["8_30d", "8–30d"],
  ["31_90d", "31–90d"],
  ["91d_plus", "91d+"],
];

const FIX_AGE_LABELS: Array<[FixAgeBucket, string]> = [
  ["0_1d", "0–1d"],
  ["2_7d", "2–7d"],
  ["8_30d", "8–30d"],
  ["31_90d", "31–90d"],
  ["91_365d", "91–365d"],
  ["366d_plus", "366d+"],
];

function percent(value: number | null): string {
  return value == null
    ? "Unknown"
    : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "neutral" | "arrival" | "closure" | "regression";
}) {
  const toneClass = {
    neutral: "text-ink",
    arrival: "text-amber-600 dark:text-amber-300",
    closure: "text-emerald-600 dark:text-emerald-300",
    regression: "text-red-600 dark:text-red-300",
  }[tone];
  return (
    <div className="min-w-0 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
        {label}
      </dt>
      <dd className={`mt-1 font-mono text-2xl tabular-nums ${toneClass}`}>
        {value}
      </dd>
      <dd className="mt-1 text-xs leading-5 text-ink-tertiary">{detail}</dd>
    </div>
  );
}

function Distribution({
  label,
  rows,
  total,
  colorClass,
}: {
  label: string;
  rows: Array<{ key: string; label: string; value: number }>;
  total: number;
  colorClass: string;
}) {
  return (
    <div aria-label={label} className="space-y-2.5">
      {rows.map((row) => {
        const width = total === 0 ? 0 : Math.max(2, (row.value / total) * 100);
        return (
          <div
            key={row.key}
            className="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-3"
          >
            <span className="text-xs text-ink-secondary">{row.label}</span>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
              aria-hidden="true"
            >
              <div
                className={`h-full rounded-full ${colorClass}`}
                style={{ width: `${width}%` }}
              />
            </div>
            <span className="text-right font-mono text-xs tabular-nums text-ink-secondary">
              {row.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EvidenceGap({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="grid gap-1 border-t border-border-subtle py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      <span className="text-xs leading-5 text-ink-tertiary">
        Unavailable — {reason}
      </span>
    </div>
  );
}

export function DebtMovement({ debt }: { debt: CodebaseDebtKpis }) {
  const { movement } = debt;
  const openAgeRows: Array<{ key: string; label: string; value: number }> =
    OPEN_AGE_LABELS.map(([key, label]) => ({
      key,
      label,
      value: movement.openAge[key],
    }));
  if (movement.openAge.unknown > 0) {
    openAgeRows.push({
      key: "unknown",
      label: "Unknown",
      value: movement.openAge.unknown,
    });
  }
  const severityRows = (["critical", "high", "medium", "low"] as const).map(
    (key) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      value: movement.severity[key],
    }),
  );

  return (
    <section
      aria-labelledby="debt-movement-heading"
      className="border-y border-border-subtle py-5"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
            Debt movement
          </p>
          <h2
            id="debt-movement-heading"
            className="mt-1 font-display text-xl text-ink text-balance"
          >
            Is the codebase paying debt down?
          </h2>
        </div>
        <p className="text-xs text-ink-tertiary">
          Stock as of {new Date(movement.asOf).toLocaleDateString()} · flow in
          selected range
        </p>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-border-subtle pb-5 lg:border-r lg:border-b-0 lg:pr-5 lg:pb-0">
          <dl className="grid grid-cols-2 gap-x-5">
            <Metric
              label="Actionable"
              value={movement.actionable}
              detail={`${movement.actionableOpen} open · ${movement.actionableReopened} reopened`}
              tone="arrival"
            />
            <Metric
              label="Suppressed"
              value={movement.suppressed}
              detail={`${movement.suppressions.accepted} accepted · ${movement.suppressions.riskAccepted} risk · ${movement.suppressions.falsePositive} false positive`}
            />
          </dl>
          {movement.expiryReturnsToActionable > 0 ? (
            <p className="border-t border-border-subtle pt-3 text-xs leading-5 text-ink-tertiary">
              {movement.expiryReturnsToActionable} expired decision
              {movement.expiryReturnsToActionable === 1 ? " is" : "s are"}{" "}
              actionable again. Expiry flow is not emitted as a ledger event, so
              it is excluded from arrivals.
            </p>
          ) : null}
        </div>

        <dl className="grid grid-cols-3 gap-x-5">
          <Metric
            label="Arrivals"
            value={movement.arrivals}
            detail={`${movement.detected} detected · ${movement.reopened} reopened`}
            tone="arrival"
          />
          <Metric
            label="Closures"
            value={movement.closures}
            detail="Resolved transitions only"
            tone="closure"
          />
          <Metric
            label="Net flow"
            value={`${movement.netFlow > 0 ? "+" : ""}${movement.netFlow}`}
            detail={
              movement.netFlow > 0
                ? "Stock grew"
                : movement.netFlow < 0
                  ? "Stock shrank"
                  : "Flat"
            }
            tone={
              movement.netFlow > 0
                ? "regression"
                : movement.netFlow < 0
                  ? "closure"
                  : "neutral"
            }
          />
        </dl>
      </div>

      <div className="mt-5 grid gap-5 border-t border-border-subtle pt-5 md:grid-cols-2">
        <div>
          <h3 className="mb-3 text-xs font-semibold text-ink-secondary">
            Open age
          </h3>
          <Distribution
            label="Actionable findings by open-age bucket"
            rows={openAgeRows}
            total={movement.actionable}
            colorClass="bg-amber-500"
          />
        </div>
        <div>
          <h3 className="mb-3 text-xs font-semibold text-ink-secondary">
            Current severity
          </h3>
          <Distribution
            label="Actionable findings by current severity"
            rows={severityRows}
            total={movement.actionable}
            colorClass="bg-red-500"
          />
          <p className="mt-3 text-[11px] leading-4 text-ink-tertiary">
            Historical severity is unavailable until finding events carry
            event-time snapshots.
          </p>
        </div>
      </div>
    </section>
  );
}

export function DebtEvidence({ debt }: { debt: CodebaseDebtKpis }) {
  const { commits, movement } = debt;
  const fixAgeTotal = Object.values(commits.fixAge).reduce(
    (total, value) => total + value,
    0,
  );
  const fixAgeRows = FIX_AGE_LABELS.map(([key, label]) => ({
    key,
    label,
    value: commits.fixAge[key],
  }));

  return (
    <section
      aria-labelledby="debt-evidence-heading"
      className="border-y border-border-subtle py-5"
    >
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
          Fix age
        </p>
        <h2
          id="debt-evidence-heading"
          className="mt-1 font-display text-xl text-ink text-balance"
        >
          Is repair reaching old code?
        </h2>
      </div>

      <div className="mt-5">
        {commits.fixAnalysisCommits > 0 ? (
          <>
            <Distribution
              label="Blamed parent-side lines in fix commits by line age"
              rows={fixAgeRows}
              total={fixAgeTotal}
              colorClass="bg-emerald-500"
            />
            <p className="mt-3 text-xs text-ink-tertiary">
              <span className="font-mono tabular-nums text-ink-secondary">
                {commits.blamedParentLines}/{commits.candidateParentLines}
              </span>{" "}
              parent-side lines blamed · {percent(commits.blameCoveragePct)}{" "}
              coverage · {commits.fixAnalysisCommits}/{commits.fixCommits}{" "}
              observed fix commits analyzed
            </p>
          </>
        ) : (
          <p className="text-sm leading-6 text-ink-tertiary">
            Unavailable — no versioned first-parent line-blame observations have
            reached this codebase.
          </p>
        )}
      </div>

      <div className="mt-6 grid gap-6 border-t border-border-subtle pt-5 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Mix &amp; delivery</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-5">
            <Metric
              label="Fix share"
              value={percent(commits.fixSharePct)}
              detail={`${commits.classes.fix} fix / ${commits.classes.fix + commits.classes.feat} fix + feat`}
              tone="closure"
            />
            <Metric
              label="Classification"
              value={percent(commits.classificationCoveragePct)}
              detail={`${commits.classes.other} other · ${commits.classes.unparseable} unparseable · ${percent(commits.feedCoveragePct)} feed coverage`}
            />
          </dl>
          <p className="text-[11px] leading-4 text-ink-tertiary">
            Commit mix describes work type; it is not a debt-paydown result.
            {commits.scannerWindowDays != null
              ? ` Feed coverage uses the scanner’s ${commits.scannerWindowDays}-day window.`
              : " Scanner-window coverage is unknown."}
          </p>
          <div className="mt-3">
            <EvidenceGap
              label="PR cycle time"
              reason="merged-at evidence is absent"
            />
            <EvidenceGap
              label="Actual cost"
              reason="durable work linkage and a feature comparator are absent"
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-ink">Durability</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-5">
            <Metric
              label="Reopened"
              value={movement.recurrence.reopened}
              detail={`${movement.recurrence.eligibleResolvedFindings} resolved findings eligible · ${percent(movement.recurrence.ratePct)}`}
              tone={movement.recurrence.reopened > 0 ? "regression" : "neutral"}
            />
            <Metric
              label="Fix-on-fix"
              value={percent(commits.fixOnFixPct)}
              detail={`${commits.priorFixParentLines}/${commits.blamedParentLines} blamed lines`}
              tone={
                commits.fixOnFixPct != null && commits.fixOnFixPct > 0
                  ? "regression"
                  : "neutral"
              }
            />
          </dl>
          <p className="text-[11px] leading-4 text-ink-tertiary">
            Reopens are finding events; fix-on-fix is a line-history proxy. They
            remain separate.
          </p>
          <div className="mt-3">
            <EvidenceGap
              label="14-day escape"
              reason="merge-to-regression attribution is absent"
            />
            <EvidenceGap
              label="Intake accuracy"
              reason="the verification cohort has no defined outcome denominator"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
