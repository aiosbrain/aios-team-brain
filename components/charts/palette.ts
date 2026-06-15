/** Chart colors mirror the Prism Light accent tokens (recharts needs hex). */
export const PRISM = {
  violet: "#7c3aed",
  blue: "#3b82f6",
  cyan: "#2dd4bf",
  emerald: "#4ade80",
  amber: "#f59e0b",
  red: "#ef4444",
  fuchsia: "#d946ef",
} as const;

export const AXIS_TICK = { fontSize: 11, fill: "rgba(15,15,17,0.48)" };
export const GRID_STROKE = "rgba(0,0,0,0.06)";

export const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid rgba(0,0,0,0.08)",
  fontSize: 12,
  boxShadow: "0 4px 18px rgba(124,58,237,0.10)",
} as const;
