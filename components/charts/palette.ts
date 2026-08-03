/** Chart colors use canonical runtime tokens; Recharts accepts CSS color values. */
export const PRISM = {
  violet: "var(--aios-violet)",
  accent: "var(--aios-accent)",
  cyan: "var(--aios-cyan)",
  emerald: "var(--aios-emerald)",
  amber: "var(--aios-amber)",
  red: "var(--aios-destructive)",
  fuchsia: "var(--aios-fuchsia)",
} as const;

export const AXIS_TICK = { fontSize: 11, fill: "var(--aios-fg-muted)" };
export const GRID_STROKE = "var(--aios-border)";

export const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid var(--aios-border)",
  fontSize: 12,
  boxShadow: "var(--aios-shadow-overlay)",
} as const;
