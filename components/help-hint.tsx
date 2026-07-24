import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A tiny "?" help affordance that reveals an explanatory popover on hover/focus. CSS-only (no client
 * JS), so it can sit inside a server component; keyboard-accessible via `group-focus-within` on the
 * focusable icon button. The popover resets the parent's uppercase/tracking so prose reads normally,
 * and is `pointer-events-none` so it never blocks the content beneath it.
 */
export function HelpHint({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: ReactNode;
  /** Which edge the popover aligns to (use "right" near the right edge of a card). */
  align?: "left" | "right";
}) {
  const tipId = `help-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
  return (
    <span className="group/hint relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tipId}
        className="inline-flex size-4 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:text-ink focus-visible:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-violet/40"
      >
        <HelpCircle className="size-3.5" aria-hidden />
      </button>
      {/* `hidden` → `block` (not opacity): a hidden popover must NOT take layout — else this 18rem box
          triggers permanent horizontal scroll on a phone AND screen readers read the prose as heading
          text. max-w caps it on narrow screens. */}
      <span
        id={tipId}
        role="tooltip"
        className={`pointer-events-none absolute top-6 z-20 hidden w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border-subtle bg-surface-overlay p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-secondary shadow-lg group-hover/hint:block group-focus-within/hint:block ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </span>
    </span>
  );
}
