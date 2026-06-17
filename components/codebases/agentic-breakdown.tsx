import { Check, X } from "lucide-react";
import type { AgenticBreakdown as Breakdown } from "@/lib/metrics/codebases";
import { AGENTIC_WEIGHTS } from "@/lib/codebases/score";
import { ScoreRing } from "./score-ring";

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

export function AgenticBreakdownCard({ b }: { b: Breakdown }) {
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
          const value = b[row.score] as number;
          const weight = AGENTIC_WEIGHTS[row.key];
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-secondary">{row.label}</span>
                <span className="text-ink-tertiary">
                  {value} <span className="opacity-60">· {Math.round(weight * 100)}%</span>
                </span>
              </div>
              <Bar value={value} />
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border-subtle pt-3">
        <Check2 ok={b.has_claude_md} label="CLAUDE.md" />
        <Check2 ok={b.has_agents_md} label="AGENTS.md" />
        <Check2 ok={b.skills_count > 0} label={`${b.skills_count} skills`} />
        <Check2 ok={b.commands_count > 0} label={`${b.commands_count} commands`} />
        <Check2
          ok={b.test_coverage_pct != null}
          label={b.test_coverage_pct == null ? "no coverage report" : `${b.test_coverage_pct}% coverage`}
        />
      </div>
    </section>
  );
}
