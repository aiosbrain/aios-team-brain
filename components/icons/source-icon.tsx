import { SquareCheckBig, Mic, FileText } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Per-source icon + label for the Timeline evidence. Real brand logomarks (inline single-path SVGs from
 * simple-icons, `currentColor` so each inherits its brand tint) cover the connectors that ship a mark —
 * GitHub, Linear, Notion, Slack, Google Drive, Confluence, Plane. The few without a public glyph
 * (Granola meetings, generic PM tasks, unclassified files) fall back to a representative lucide icon.
 * Add a new brand: drop its simple-icons path in as a `*Mark` and wire it into `MAP` — callers unchanged.
 */

type MarkProps = { className?: string };

/** Inline single-path brand mark. `fill="currentColor"` so the `MAP` color tints it. */
function brandMark(path: string): ComponentType<MarkProps> {
  function Mark({ className }: MarkProps) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
        <path d={path} />
      </svg>
    );
  }
  return Mark;
}

// Brand paths (simple-icons, viewBox 0 0 24 24).
const GithubMark = brandMark(
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
);
const LinearMark = brandMark(
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
);
const NotionMark = brandMark(
  "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
);
const SlackMark = brandMark(
  "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
);
const DriveMark = brandMark(
  "M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"
);
const ConfluenceMark = brandMark(
  "M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1 599.851 599.851 0 0 1-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z"
);
const PlaneMark = brandMark(
  "M0 5.358a.854.854 0 0 1 1.235-.767L6.134 7.05v5.768c0 .81.456 1.553 1.179 1.915l4.42 2.218v1.692a.853.853 0 0 1-1.235.766L1.18 14.732A2.14 2.14 0 0 1 0 12.817zm6.134 0a.853.853 0 0 1 1.235-.766l4.898 2.458v5.768c0 .81.457 1.552 1.18 1.915l4.42 2.218v1.692a.853.853 0 0 1-1.235.765l-4.899-2.457v-5.769a2.14 2.14 0 0 0-1.179-1.914L6.134 7.05zm6.133 0a.853.853 0 0 1 1.235-.766l9.319 4.676A2.14 2.14 0 0 1 24 11.182v7.46a.853.853 0 0 1-1.235.766l-4.899-2.457v-5.769a2.14 2.14 0 0 0-1.179-1.914l-4.42-2.218z"
);

type IconCmp = ComponentType<MarkProps>;

const MAP: Record<string, { Icon: IconCmp; color: string; label: string }> = {
  github: { Icon: GithubMark, color: "text-ink", label: "GitHub" },
  linear: { Icon: LinearMark, color: "text-[#5E6AD2]", label: "Linear" },
  plane: { Icon: PlaneMark, color: "text-[#3f76ff]", label: "Plane" },
  tasks: { Icon: SquareCheckBig, color: "text-violet", label: "Tasks" }, // PM tasks, no provider configured
  slack: { Icon: SlackMark, color: "text-[#611f69] dark:text-[#e01e5a]", label: "Slack" },
  notion: { Icon: NotionMark, color: "text-ink", label: "Notion" },
  confluence: { Icon: ConfluenceMark, color: "text-[#1868db]", label: "Confluence" },
  granola: { Icon: Mic, color: "text-emerald-600", label: "Meetings" },
  gdrive: { Icon: DriveMark, color: "text-[#1a73e8]", label: "Drive" },
  other: { Icon: FileText, color: "text-ink-tertiary", label: "Files" },
};

export function sourceLabel(source: string): string {
  return (MAP[source] ?? MAP.other).label;
}

export function SourceIcon({ source, className = "size-4" }: { source: string; className?: string }) {
  const { Icon, color } = MAP[source] ?? MAP.other;
  return <Icon className={`${className} ${color} shrink-0`} />;
}
