import type { Metadata } from "next";
import { Instrument_Serif, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { StagingBanner } from "@/components/layout/staging-banner";

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

/**
 * STGENV-1 — never prerender anything under this layout.
 *
 * MEASURED: with this absent, `npm run build` bakes the staging banner's decision into the prerendered
 * `/_not-found` route — built with `RAILWAY_ENVIRONMENT_NAME=staging` the 404 page carries the banner,
 * built without it the page carries none, and neither answer changes at runtime. Every data-bearing
 * page is dynamic by construction (cookies, DB, searchParams), so the prod-data hazard is not reached
 * today — but "a banner on every page" is false for that one route, and the mechanism widens silently
 * the day a page stops touching a request API.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Team Brain", template: "%s · Team Brain" },
  description: "Shared memory and coordination for AIOS teams.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${instrumentSerif.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-surface-base">
        {/* STGENV-1: above and outside the providers so no page-level layout can cover it, and so it
            survives a PAGE crash (app/t/[team]/error.tsx keeps this layout). It does NOT survive a
            provider throw — global-error.tsx replaces the whole document, banner included. */}
        <StagingBanner />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
