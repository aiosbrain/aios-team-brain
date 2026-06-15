import type { ReactNode } from "react";

export function ChartCard({
  title,
  hint,
  empty,
  emptyLabel = "No data in this window.",
  children,
}: {
  title: string;
  hint?: string;
  empty?: boolean;
  emptyLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="prism-card flex flex-col px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          {title}
        </h2>
        {hint ? <span className="text-[11px] text-ink-tertiary">{hint}</span> : null}
      </div>
      {empty ? (
        <div className="flex h-[200px] items-center justify-center text-sm text-ink-tertiary">
          {emptyLabel}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
