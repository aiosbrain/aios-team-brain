const STYLES: Record<string, string> = {
  deliverable: "bg-violet/8 text-violet border-violet/25",
  transcript: "bg-blue/8 text-blue border-blue/25",
  decision: "bg-amber/10 text-amber-700 border-amber/30",
  task: "bg-emerald/10 text-emerald-700 border-emerald/30",
  skill: "bg-fuchsia-500/10 text-fuchsia-700 border-fuchsia-500/30",
  artifact: "bg-surface-overlay text-ink-secondary border-border-default",
};

export function KindBadge({ kind }: { kind: string }) {
  const cls = STYLES[kind] ?? STYLES.artifact;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${cls}`}
    >
      {kind}
    </span>
  );
}
