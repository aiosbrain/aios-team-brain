import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getWelcomeContext } from "@/lib/auth/welcome-context";

export const metadata: Metadata = { title: "Welcome" };

function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function teamSlugFromPath(path: string): string | null {
  const m = /^\/t\/([^/?]+)/.exec(path);
  return m ? m[1] : null;
}

/**
 * Shown once, on a member's first login (see app/auth/confirm/route.ts), instead of
 * dropping them straight onto the dashboard with no acknowledgement of who they are
 * or who invited them.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNext(next);

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const teamSlug = teamSlugFromPath(dest);
  const ctx = teamSlug ? await getWelcomeContext(teamSlug, user.email) : null;
  const firstName = ctx?.inviteeName.trim().split(/\s+/)[0] || "there";

  return (
    <main className="relative flex flex-1 items-center justify-center bg-surface-raised px-6 py-24">
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
            <p className="font-display text-sm font-semibold uppercase tracking-[0.15em] text-gradient-prism">
              Team Brain
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-ink">Welcome, {firstName}</h1>
            <p className="mt-1 mb-6 text-sm text-ink-secondary">
              {ctx
                ? ctx.inviterName
                  ? `${ctx.inviterName} added you to ${ctx.teamName}.`
                  : `You're joining ${ctx.teamName}.`
                : "You're all set."}
            </p>
            <a href={dest} className="btn-prism w-full justify-center">
              Continue to your dashboard
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
