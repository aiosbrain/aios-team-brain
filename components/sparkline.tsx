/**
 * Inline SVG sparkline. Inherits its color from the parent via `currentColor`
 * (wrap in a colored span, or pass a text-* className). Server-safe (no hooks).
 */
export function Sparkline({
  data,
  width = 64,
  height = 20,
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`overflow-visible${className ? ` ${className}` : ""}`}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
    </svg>
  );
}
