"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ShieldAlert } from "lucide-react";

export default function AdminError({
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
      <ShieldAlert className="size-8 text-violet" strokeWidth={1.5} />
      <h1 className="text-xl font-semibold text-ink">Something went wrong in Admin</h1>
      <p className="text-sm text-ink-secondary">
        An unexpected error occurred and has been reported. The rest of the app is unaffected.
      </p>
      <button type="button" onClick={() => reset()} className="btn-ghost mt-2">
        Try again
      </button>
    </div>
  );
}
