"use client";

import { ThemeProvider } from "next-themes";

/** Theme provider for the AIOS design system. Dark mode is class-driven
 *  (`class="dark"` on <html>); team-brain defaults to light (long reading
 *  sessions) and ships a toggle. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
