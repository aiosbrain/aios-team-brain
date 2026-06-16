import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isPostgresBackend } from "@/lib/db/backend";
import { issueMagicToken } from "@/lib/auth/pg-login";
import { sendMagicLink } from "@/lib/auth/mailer";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(200),
  next: z.string().optional(),
});

/**
 * Magic-link request for the postgres backend (supabase mode uses the client
 * SDK directly). Invite-only: a token is only issued for emails that already
 * have a member row, but the response is always `{ ok: true }` so the endpoint
 * doesn't reveal which emails exist.
 */
export async function POST(req: NextRequest) {
  if (!isPostgresBackend()) {
    return NextResponse.json({ error: "not_applicable" }, { status: 400 });
  }

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
  if (raw) {
    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
    await sendMagicLink(email, `${origin}/auth/confirm?token=${raw}`);
  }
  return NextResponse.json({ ok: true });
}
