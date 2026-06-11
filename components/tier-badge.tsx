const STYLES: Record<string, string> = {
  team: "bg-violet/8 text-violet border-violet/25",
  external: "bg-cyan/10 text-teal-700 border-cyan/30",
};

export function TierBadge({ tier }: { tier: string }) {
  const cls = STYLES[tier] ?? "bg-surface-overlay text-ink-tertiary border-border-default";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${cls}`}
    >
      {tier}
    </span>
  );
}
