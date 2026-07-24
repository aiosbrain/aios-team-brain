"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsagePoint } from "@/lib/metrics/pulse";
import { AXIS_TICK, GRID_STROKE, PRISM, TOOLTIP_STYLE } from "./palette";
import { ChartCard } from "./chart-card";

export function UsageChart({ data, scope }: { data: UsagePoint[]; scope: string }) {
  const empty = data.every((d) => d.queries === 0);

  return (
    <ChartCard
      title="Brain usage"
      hint={`${scope} queries / day`}
      help={
        <>
          <span className="font-medium text-ink">What this is</span>
          <br />
          Questions asked to the brain, bucketed by the day they were asked, across the selected
          range. Each answered query writes one row to the query log; this counts those rows per day.
          <br />
          <br />
          Scope follows who&apos;s looking: admins see the whole team&apos;s queries, everyone else
          sees only their own.
        </>
      }
      empty={empty}
      emptyLabel="No queries in this window."
    >
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="usageFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PRISM.blue} stopOpacity={0.35} />
              <stop offset="100%" stopColor={PRISM.blue} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="date"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Area
            type="monotone"
            dataKey="queries"
            stroke={PRISM.blue}
            strokeWidth={2}
            fill="url(#usageFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
