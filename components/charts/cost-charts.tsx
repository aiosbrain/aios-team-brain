"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ExternalMemberCosts,
  SpendDayPoint,
  TokenDayPoint,
} from "@/lib/metrics/external-costs";
import { AXIS_TICK, GRID_STROKE, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

/** Stable provider → color. Falls back to a cycle for unknown providers. */
const PROVIDER_COLOR: Record<string, string> = {
  claude: PRISM.violet,
  cursor: PRISM.blue,
  codex: PRISM.emerald,
  opencode: PRISM.amber,
  anthropic: PRISM.fuchsia,
  openai: PRISM.cyan,
  other: PRISM.red,
};
const CYCLE = [
  PRISM.violet,
  PRISM.blue,
  PRISM.emerald,
  PRISM.amber,
  PRISM.cyan,
  PRISM.fuchsia,
  PRISM.red,
];
/**
 * Stable per-provider color. Unknown providers hash their NAME into the cycle
 * (not their array index) so the same provider gets the same color across the
 * stacked chart (ordered by rank) and the share doughnut (ordered by cost).
 */
function providerColor(provider: string): string {
  const mapped = PROVIDER_COLOR[provider];
  if (mapped) return mapped;
  let h = 0;
  for (let i = 0; i < provider.length; i++)
    h = (h * 31 + provider.charCodeAt(i)) | 0;
  return CYCLE[Math.abs(h) % CYCLE.length];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Daily spend, one stacked segment per provider. The headline chart. */
export function SpendByProviderChart({
  data,
  providers,
}: {
  data: SpendDayPoint[];
  providers: string[];
}) {
  const empty = data.length === 0 || providers.length === 0;
  return (
    <ChartCard
      title="Daily spend by provider"
      hint="USD / day"
      empty={empty}
      emptyLabel="No provider spend in this window."
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, left: -12, bottom: 0 }}
        >
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="date"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => `$${compact(v)}`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v) => usd(Number(v))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {providers.map((p, i) => (
            <Bar
              key={p}
              dataKey={p}
              stackId="spend"
              fill={providerColor(p)}
              name={p}
              radius={i === providers.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

const TOKEN_COLORS = {
  input: PRISM.blue,
  output: PRISM.violet,
  cache_read: PRISM.cyan,
};

/** Daily tokens, stacked by kind (input / output / cache-read) across all providers. */
export function TokenTrendChart({ data }: { data: TokenDayPoint[] }) {
  const empty = data.every(
    (d) => d.input === 0 && d.output === 0 && d.cache_read === 0,
  );
  return (
    <ChartCard
      title="Daily tokens"
      hint="input · output · cache-read"
      empty={empty}
      emptyLabel="No token activity in this window."
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, left: -4, bottom: 0 }}
        >
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="date"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => compact(v)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v) => Number(v).toLocaleString("en-US")}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="input"
            stackId="tok"
            fill={TOKEN_COLORS.input}
            name="Input"
          />
          <Bar
            dataKey="output"
            stackId="tok"
            fill={TOKEN_COLORS.output}
            name="Output"
          />
          <Bar
            dataKey="cache_read"
            stackId="tok"
            fill={TOKEN_COLORS.cache_read}
            name="Cache read"
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Cost share across providers for the window (doughnut). */
export function ProviderShareChart({
  data,
}: {
  data: { provider: string; cost_usd: number; events: number }[];
}) {
  const empty = data.length === 0 || data.every((d) => d.cost_usd === 0);
  return (
    <ChartCard
      title="Cost share by provider"
      empty={empty}
      emptyLabel="No spend in this window."
    >
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={data}
            dataKey="cost_usd"
            nameKey="provider"
            innerRadius={52}
            outerRadius={88}
            paddingAngle={2}
          >
            {data.map((d) => (
              <Cell key={d.provider} fill={providerColor(d.provider)} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v) => usd(Number(v))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Spend per member (team rollup, admin-only). Horizontal bars, biggest first. */
export function MemberSpendChart({ rows }: { rows: ExternalMemberCosts[] }) {
  const data = rows
    .map((r) => ({ name: r.member_name, cost_usd: r.cost_usd }))
    .filter((r) => r.cost_usd > 0)
    .slice(0, 12);
  const empty = data.length === 0;
  return (
    <ChartCard
      title="Spend by member"
      hint="team, top 12"
      empty={empty}
      emptyLabel="No attributed spend."
    >
      <ResponsiveContainer
        width="100%"
        height={Math.max(160, data.length * 30)}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `$${compact(v)}`}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={120}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v) => usd(Number(v))}
          />
          <Bar
            dataKey="cost_usd"
            fill={PRISM.violet}
            radius={[0, 3, 3, 0]}
            name="Spend"
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
