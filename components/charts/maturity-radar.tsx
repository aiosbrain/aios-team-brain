"use client";

import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Legend,
  Tooltip,
} from "recharts";
import { PRISM, GRID_STROKE, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

export type RadarDatum = { axis: string; you: number; team?: number };

/**
 * AEM 5-axis radar (scores 0–4). Optionally overlays a second series (e.g. the
 * team average) for comparison on the member deep-dive.
 */
export function MaturityRadar({
  data,
  primaryLabel = "Score",
  showTeam = false,
  title = "Maturity radar",
  hint = "axes scored 0–4",
}: {
  data: RadarDatum[];
  primaryLabel?: string;
  showTeam?: boolean;
  title?: string;
  hint?: string;
}) {
  return (
    <ChartCard title={title} hint={hint} empty={data.length === 0}>
      <ResponsiveContainer width="100%" height={300}>
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke={GRID_STROKE} />
          <PolarAngleAxis dataKey="axis" tick={{ fill: "var(--color-ink-subtle)", fontSize: 11 }} />
          <PolarRadiusAxis domain={[0, 4]} tickCount={5} tick={{ fill: "var(--color-ink-subtle)", fontSize: 10 }} />
          {showTeam && (
            <Radar name="Team avg" dataKey="team" stroke={PRISM.cyan} fill={PRISM.cyan} fillOpacity={0.12} strokeWidth={1.5} />
          )}
          <Radar name={primaryLabel} dataKey="you" stroke={PRISM.violet} fill={PRISM.violet} fillOpacity={0.3} strokeWidth={2} />
          {showTeam && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Tooltip contentStyle={TOOLTIP_STYLE} />
        </RadarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
