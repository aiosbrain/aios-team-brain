import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { issueMagicToken } from "@/lib/auth/pg-login";
import { sendMagicLink } from "@/lib/auth/mailer";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(200),
  next: z.string().optional(),
});

/**
 * Request a magic sign-in link — an OPTIONAL secondary sign-in path (email+password at
 * POST /api/auth/login is the default; see that route's docblock). Never sets a session cookie
 * itself; only GET /auth/confirm does that, once the emailed link is actually clicked. Keeps the
 * explicit 403 for an unrecognized email (invite-only, no password to brute-force here — not a
 * meaningful enumeration risk for this self-hosted, small known-member product). The login form
 * only offers this option when a domain + mail provider are configured (`magicLinkAvailable`); the
 * route itself stays reachable regardless — with no provider configured, `sendMagicLink` degrades
 * to its existing dev-log/drop-and-log behavior (lib/auth/mailer), same as every other email here.
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

  const email = parsed.data.email.trim().toLowerCase();
  const nextParam = parsed.data.next ?? "/";
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  const raw = await issueMagicToken(email, safeNext);
  if (!raw) {
    // Not a recognized member — invite-only.
    return NextResponse.json({ error: "not_recognized" }, { status: 403 });
  }

  const appUrl = (process.env.APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  await sendMagicLink(email, `${appUrl}/auth/confirm?token=${raw}`);
  return NextResponse.json({ ok: true });
}
