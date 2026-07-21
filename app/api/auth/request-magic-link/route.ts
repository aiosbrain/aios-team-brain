import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { issueMagicToken } from "@/lib/auth/pg-login";
import { sendMagicLink, appBaseUrl } from "@/lib/auth/mailer";
import { safeNextPath } from "@/lib/auth/next-path";
import { rateLimit } from "@/lib/api/rate-limit";
import { adminClient } from "@/lib/db/admin";

export const runtime = "nodejs";

// Magic-link requests allowed per client IP per minute. Stricter than password login (10/min) because
// each recognized request sends a real email — this caps mailbox-bombing / token-spam of a known
// member. Throttling is by IP, independent of email membership, so it leaks nothing an attacker
// couldn't already learn from their own address (both known and unknown emails throttle identically).
const MAGIC_LINK_RATE_PER_MIN = 5;

const schema = z.object({
  email: z.string().email().max(200),
  next: z.string().optional(),
});

/**
 * Request a magic sign-in link — an OPTIONAL secondary sign-in path (email+password at
 * POST /api/auth/login is the default; see that route's docblock). Never sets a session cookie
 * itself; only GET /auth/confirm does that, once the emailed link is actually clicked. Every valid
 * request gets the same response and schedules the same after-response job. Member lookup, token
 * insertion, and provider I/O all happen inside that job so neither response shape nor timing
 * reveals whether the email belongs to a member. The login form only offers this option when a
 * domain + mail provider are configured (`magicLinkAvailable`); the route itself stays reachable
 * regardless — with no trusted `APP_URL` there is no safe link to build, so the after-job no-ops.
 *
 * Not reusing `lib/admin/issueLoginLink` here on purpose: that primitive writes a team-scoped
 * `login_link.issued` audit row, but this is an unauthenticated pre-login request with no actor and
 * no resolved team (membership is only known inside the after-job), so an audit entry would be
 * misattributed. Admin-initiated issuance keeps the audit trail; self-service does not.
 *
 * Delivery is best-effort: `after()` runs post-response and is not durable, so a job scheduled just
 * before the process is replaced (a deploy) can be dropped — the caller already saw 200. Failures
 * inside the job are logged (not surfaced), since the uniform response must not reveal membership.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 422 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_email" }, { status: 422 });

  // Throttle by client IP before scheduling any work. x-forwarded-for's first hop is the client on
  // Railway/Vercel edge. Independent of membership, so it stays enumeration-safe.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!(await rateLimit(adminClient(), `magic-link:${ip}`, MAGIC_LINK_RATE_PER_MIN))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const safeNext = safeNextPath(parsed.data.next);

  // Trusted base URL from APP_URL only — never the (spoofable) request host. Resolved on the
  // response path so a misconfiguration doesn't change per-email timing.
  const appUrl = appBaseUrl();
  after(async () => {
    try {
      if (!appUrl) return; // no trusted domain configured → no safe link to send (mirrors magicLinkAvailable)
      const raw = await issueMagicToken(email, safeNext);
      if (!raw) return; // not a recognized member — invite-only; stop silently
      await sendMagicLink(email, `${appUrl}/auth/confirm?token=${raw}`);
    } catch (err) {
      // sendMagicLink never throws (the mailer swallows provider errors), so this only fires on
      // token-issuance (DB) failure. Logged, not surfaced — the 200 already went out.
      console.error("[auth] magic-link token issuance failed:", err instanceof Error ? err.message : err);
    }
  });

  return NextResponse.json({ ok: true });
}
