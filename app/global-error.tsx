"use client"; // Error boundaries must be Client Components.

/**
 * Root-level error boundary. This replaces the root layout when an error is
 * thrown above any nested `error.tsx` (e.g. in the root layout itself), so it
 * must render its own <html>/<body>. We report the error to Sentry on mount.
 *
 * `metadata` exports are not supported here; use the React <title> element.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    // global-error must include html and body tags.
    <html lang="en">
      <body>
        <title>Something went wrong · Team Brain</title>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            fontFamily: "system-ui, sans-serif",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ color: "#666", maxWidth: "32rem" }}>
            An unexpected error occurred and has been reported. You can try again.
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
