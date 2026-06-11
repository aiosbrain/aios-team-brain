import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";

/**
 * Prism-styled empty state: every list view renders one of these with a
 * concrete next action instead of a blank screen.
 */
export function EmptyState({
  icon: Icon = Sparkles,
  title,
  action,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  action: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="prism-card flex flex-col items-center gap-3 px-8 py-14 text-center">
      <div className="bg-gradient-prism rounded-xl p-[1px]">
        <div className="rounded-xl bg-surface-inset p-3">
          <Icon className="size-6 text-violet" strokeWidth={1.5} />
        </div>
      </div>
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      <p className="max-w-md text-sm text-ink-secondary">{action}</p>
      {children}
    </div>
  );
}
