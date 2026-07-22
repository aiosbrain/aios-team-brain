import { SquareCheckBig, SquareKanban, Hash, FileText, Mic, HardDrive, UserPlus } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Per-source icon + label for the Timeline evidence. GitHub uses its real brand mark (inline — recent
 * lucide dropped the `Github` glyph); the rest map to a representative lucide icon tinted with the
 * brand's color (a checked square for Linear/tasks, a kanban board for Plane, a hash for Slack, …).
 * Swap to a full brand-logo set (e.g. simple-icons) later for pixel-accurate marks without touching callers.
 */

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

type IconCmp = ComponentType<{ className?: string }>;

const MAP: Record<string, { Icon: IconCmp; color: string; label: string }> = {
  github: { Icon: GithubMark, color: "text-ink", label: "GitHub" },
  linear: { Icon: SquareCheckBig, color: "text-[#5E6AD2]", label: "Linear" },
  plane: { Icon: SquareKanban, color: "text-[#3f76ff]", label: "Plane" },
  tasks: { Icon: SquareCheckBig, color: "text-violet", label: "Tasks" }, // PM tasks, no provider configured
  "newly-assigned": { Icon: UserPlus, color: "text-amber-600", label: "Newly assigned" }, // tasks just assigned to this person
  slack: { Icon: Hash, color: "text-[#611f69] dark:text-[#e01e5a]", label: "Slack" },
  notion: { Icon: FileText, color: "text-ink", label: "Notion" },
  confluence: { Icon: FileText, color: "text-[#1868db]", label: "Confluence" },
  granola: { Icon: Mic, color: "text-emerald-600", label: "Meetings" },
  gdrive: { Icon: HardDrive, color: "text-[#1a73e8]", label: "Drive" },
  other: { Icon: FileText, color: "text-ink-tertiary", label: "Files" },
};

export function sourceLabel(source: string): string {
  return (MAP[source] ?? MAP.other).label;
}

export function SourceIcon({ source, className = "size-4" }: { source: string; className?: string }) {
  const { Icon, color } = MAP[source] ?? MAP.other;
  return <Icon className={`${className} ${color} shrink-0`} />;
}
