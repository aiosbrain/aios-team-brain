import type { ReactNode } from "react";
import { HelpHint } from "@/components/help-hint";

export function ChartCard({
  title,
  hint,
  help,
  helpAlign = "left",
  empty,
  emptyLabel = "No data in this window.",
  children,
}: {
  title: string;
  hint?: string;
  /** Optional "?" popover in the corner explaining what the metric is and how it's computed. */
  help?: ReactNode;
  /** Edge the help popover aligns to — use "right" for a card in the right column so it can't overflow. */
  helpAlign?: "left" | "right";
  empty?: boolean;
  emptyLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="prism-card flex flex-col px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-ink-tertiary">
          {title}
          {help ? <HelpHint label={`About ${title}`} align={helpAlign}>{help}</HelpHint> : null}
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
