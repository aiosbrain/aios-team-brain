"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/** Light/dark toggle for the AIOS dual-mode design system. Mount-guarded to
 *  avoid a hydration mismatch (theme is only known client-side). */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Mount-only flag so the icon/label render client-side, avoiding a hydration
  // mismatch (the resolved theme is unknown during SSR). Intentional set-in-effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const dark = mounted && resolvedTheme === "dark";
  const toggleTheme = () =>
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle light/dark theme"
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium tracking-wide text-ink-secondary transition-all hover:bg-surface-card-hover hover:text-ink"
    >
      {dark ? (
        <Sun className="size-4" strokeWidth={1.5} />
      ) : (
        <Moon className="size-4" strokeWidth={1.5} />
      )}
      {mounted ? (dark ? "Light mode" : "Dark mode") : "Theme"}
    </button>
  );
}
