/** A compact 0–100 score ring. Pure SVG, server-safe. Color steps with the value. */
export function ScoreRing({
  value,
  label,
  size = 56,
}: {
  value: number;
  label?: string;
  size?: number;
}) {
  const v = Math.max(0, Math.min(100, value));
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (v / 100) * circ;
  const color =
    v >= 75
      ? "var(--aios-emerald)"
      : v >= 50
        ? "var(--aios-violet)"
        : v >= 25
          ? "var(--aios-amber)"
          : "var(--aios-destructive)";

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--aios-border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="fill-ink font-display"
          style={{ fontSize: size * 0.28, fontWeight: 600 }}
        >
          {Math.round(v)}
        </text>
      </svg>
      {label ? (
        <span className="text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
          {label}
        </span>
      ) : null}
    </div>
  );
}
