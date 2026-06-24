import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { publicDbBackend } from "@/lib/db/backend";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <main className="relative flex flex-1 items-center justify-center bg-surface-raised px-6 py-24">
      {/* faint prismatic backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, rgba(124,58,237,0.07), transparent 70%), radial-gradient(40% 40% at 80% 100%, rgba(45,212,191,0.06), transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-sm">
        <div className="bg-gradient-prism rounded-2xl p-[1px]">
          <div className="rounded-2xl bg-surface-inset px-8 py-10">
            <p className="font-display text-sm uppercase tracking-[0.15em] text-gradient-prism">
              Team Brain
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-ink">Sign in</h1>
            <p className="mt-1 mb-6 text-sm text-ink-secondary">
              {publicDbBackend() === "postgres"
                ? "Enter your work email to sign in."
                : "We'll email you a one-time magic link."}
            </p>
            {error === "invalid_link" ? (
              <p className="mb-4 rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-sm text-red">
                That link is invalid or expired — request a new one below.
              </p>
            ) : null}
            <LoginForm next={next} />
            <p className="mt-6 border-t border-border-subtle pt-4 text-xs text-ink-tertiary">
              Team Brain is invite-only: ask your team admin to add you before signing in.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
