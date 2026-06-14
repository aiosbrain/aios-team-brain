/** Range constants + types — client-safe (no server-only deps). */

export const RANGES = ["7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];

const DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function parseRange(value: string | undefined): Range {
  return (RANGES as readonly string[]).includes(value ?? "") ? (value as Range) : "30d";
}

export function rangeDays(range: Range): number {
  return DAYS[range];
}
