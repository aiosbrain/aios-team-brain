import { Check, X } from "lucide-react";
import type { AgenticBreakdown as Breakdown } from "@/lib/metrics/codebases";
import { AGENTIC_WEIGHTS } from "@/lib/codebases/score";
import { ScoreRing } from "./score-ring";
import { CoverageScope, PartialRunBadge, isNarrowCoverage } from "./coverage-scope";

const BARS: { key: keyof typeof AGENTIC_WEIGHTS; label: string; score: keyof Breakdown }[] = [
  { key: "test_coverage_score", label: "Test coverage", score: "test_coverage_score" },
  { key: "scaffolding_score", label: "Agent scaffolding", score: "scaffolding_score" },
  { key: "skill_breadth_score", label: "Skill breadth", score: "skill_breadth_score" },
  { key: "ai_commit_ratio", label: "AI-assisted commits", score: "ai_commit_ratio" },
  { key: "cadence_score", label: "Commit cadence", score: "cadence_score" },
];

function Bar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-inset">
      <div className="h-full rounded-full bg-gradient-prism" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function Check2({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
      {ok ? <Check className="size-3.5 text-emerald" /> : <X className="size-3.5 text-ink-tertiary" />}
      {label}
    </span>
  );
}

// Pillar keys arrive from the scanner's rubric (e.g. "testing", "agent_docs"); humanize for display.
function humanizePillar(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The agentic-score breakdown as a standalone card (score ring + weighted bars + scaffolding checks).
 *  Split from the readiness card so the two sit side-by-side under the full-width trend. */
export function AgenticScoreCard({ b }: { b: Breakdown }) {
  return (
    <section className="prism-card flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
            Agentic score
          </h2>
          <p className="mt-0.5 text-[11px] text-ink-tertiary">
            provisional heuristic — AI-transformation signal, not ground truth
          </p>
        </div>
        <ScoreRing value={b.agentic_score} size={64} />
      </div>

      <div className="flex flex-col gap-3">
        {BARS.map((row) => {
          const value = b[row.score] as number | null;
          const weight = AGENTIC_WEIGHTS[row.key];
          // A null sub-score means "not measured" and is excluded from the composite, so it
          // must not render as an empty bar sitting at 0 — that reads as a measured failure.
          const reported = value != null;
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-secondary">{row.label}</span>
                <span className="text-ink-tertiary">
                  {reported ? value : <span className="italic">no report</span>}{" "}
                  <span className="opacity-60">
                    · {reported ? `${Math.round(weight * 100)}%` : "excluded"}
                  </span>
                </span>
              </div>
              {reported ? (
                <Bar value={value} />
              ) : (
                <div className="h-2 w-full rounded-full border border-dashed border-border-subtle" />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border-subtle pt-3">
        <Check2 ok={b.has_claude_md} label="CLAUDE.md" />
        <Check2 ok={b.has_agents_md} label="AGENTS.md" />
        <Check2 ok={b.skills_count > 0} label={`${b.skills_count} skills`} />
        <Check2 ok={b.commands_count > 0} label={`${b.commands_count} commands`} />
        {/* The line-coverage check carries its DENOMINATOR (AIO-995). `ok` still tracks only
            whether a report exists — a narrow measurement is a real measurement, not a failed
            one; the amber tint and the scope suffix say how much of the repo it speaks for. */}
        <span className="inline-flex items-center gap-1.5">
          <Check2
            ok={b.test_coverage_pct != null}
            label={
              b.test_coverage_pct == null
                ? "no coverage report"
                : `${b.test_coverage_pct}% lines${isNarrowCoverage(b.coverage_breadth_pct) ? " — narrow" : ""}`
            }
          />
          {b.test_coverage_pct == null ? null : (
            <CoverageScope
              linesInstrumented={b.test_coverage_lines_total}
              loc={b.loc}
              breadthPct={b.coverage_breadth_pct}
            />
          )}
        </span>
        <Check2
          ok={b.test_coverage_functions_pct != null}
          label={b.test_coverage_functions_pct == null ? "no fn coverage" : `${b.test_coverage_functions_pct}% functions`}
        />
        <Check2
          ok={b.test_coverage_branches_pct != null}
          label={b.test_coverage_branches_pct == null ? "no branch coverage" : `${b.test_coverage_branches_pct}% branches`}
        />
        {/* Run integrity. Absent (no test-result report) renders nothing at all — an unknown
            is not a clean bill of health, and must not be drawn as one. */}
        {b.scan_partial === true ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
            <PartialRunBadge
              partial={b.scan_partial}
              skipped={b.tests_skipped}
              failed={b.tests_failed}
              total={b.tests_total}
            />
            <span className="text-ink-tertiary">
              {[
                b.tests_skipped ? `${b.tests_skipped} skipped` : null,
                b.tests_failed ? `${b.tests_failed} failed` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              {b.tests_total ? ` of ${b.tests_total} tests` : ""}
            </span>
          </span>
        ) : b.scan_partial === false && b.tests_total ? (
          <Check2 ok label={`${b.tests_total} tests, none skipped`} />
        ) : null}
      </div>
    </section>
  );
}

/** AEM agent-readiness as its own card (rubric-scored scanner-side; the brain persists + surfaces it).
 *  Returns null when a scan carried no readiness level (older scans / unscored repos) so the caller
 *  can render the score card full-width instead of leaving a dead column. */
export function AgentReadinessCard({ b }: { b: Breakdown }) {
  if (!b.readiness_level) return null;
  const pillars = Object.entries(b.readiness_pillars ?? {});
  return (
    <section className="prism-card flex flex-col gap-4 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          Agent readiness
        </h2>
        <span className="inline-flex items-baseline gap-2 font-mono text-xs">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-semibold text-ink-secondary">
            {b.readiness_level}
          </span>
          {b.readiness_pct == null ? null : <span className="text-ink-tertiary">{b.readiness_pct}%</span>}
        </span>
      </div>
      {pillars.length > 0 ? (
        <div className="flex flex-col gap-2">
          {pillars.map(([key, { passed, total }]) => (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-secondary">{humanizePillar(key)}</span>
                <span className="text-ink-tertiary">
                  {passed}/{total}
                </span>
              </div>
              <Bar value={total > 0 ? (passed / total) * 100 : 0} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
