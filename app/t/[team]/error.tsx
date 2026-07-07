"use client"; // Error boundaries must be Client Components.

/**
 * Team-scoped error boundary. Without this, an unhandled render error on any single page
 * (e.g. the July 2026 Data-page crash) falls through to app/global-error.tsx, which replaces
 * the ENTIRE <html>/<body> — including the sidebar nav — leaving the user with no way to
 * navigate away from the broken page. This boundary sits inside app/t/[team]/layout.tsx's
 * {children} slot, so the layout (nav, header) keeps rendering normally around it and only
 * the broken page's content area is replaced.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { CircleAlert } from "lucide-react";

export default function TeamError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 pt-16 text-center">
      <CircleAlert className="size-8 text-violet" strokeWidth={1.5} />
      <h1 className="text-xl font-semibold text-ink">Something went wrong on this page</h1>
      <p className="text-sm text-ink-secondary">
        An unexpected error occurred and has been reported. The rest of the app is unaffected —
        use the sidebar to go elsewhere, or retry this page.
      </p>
      <button type="button" onClick={() => reset()} className="btn-ghost mt-2">
        Try again
      </button>
    </div>
  );
}
