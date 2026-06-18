import "server-only";

/**
 * Transactional email for the postgres backend (magic links, invites).
 *
 * Delivery preference: Resend HTTP API (`RESEND_API_KEY`) → SMTP/nodemailer
 * (`SMTP_URL`) → dev log. **Logging the link is a DEV / first-run convenience only,
 * never a production delivery path** — in production with no provider, the message is
 * dropped (and an error logged), not "delivered" by logging.
 *
 * `deliver()` never throws — login/invite UX must not reveal whether delivery
 * succeeded — and returns whether a provider accepted the message.
 */
function senderFrom(): string {
  // A verified domain + RESEND_FROM is required to send to arbitrary recipients;
  // `onboarding@resend.dev` only delivers to the Resend account owner (fine for first-run).
  return (
    process.env.RESEND_FROM ??
    process.env.SMTP_FROM ??
    "AIOS Team Brain <onboarding@resend.dev>"
  );
}

async function deliver(to: string, subject: string, text: string): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: senderFrom(), to, subject, text }),
      });
      if (res.ok) return true;
      console.error(`[mailer] Resend rejected ${to}: HTTP ${res.status}`);
    } catch (err) {
      console.error(`[mailer] Resend error for ${to}:`, err instanceof Error ? err.message : err);
    }
  }

  const smtpUrl = process.env.SMTP_URL;
  if (smtpUrl) {
    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport(smtpUrl);
      await transport.sendMail({ to, from: senderFrom(), subject, text });
      return true;
    } catch (err) {
      console.error(`[mailer] SMTP send failed for ${to}:`, err instanceof Error ? err.message : err);
    }
  }

  // No provider configured. Dev/first-run only — never a prod path.
  if (process.env.NODE_ENV !== "production") {
    console.info(`[mailer] (dev, no provider) ${subject} → ${to}\n${text}`);
  } else {
    console.error(`[mailer] no provider (set RESEND_API_KEY or SMTP_URL); dropped: ${subject} → ${to}`);
  }
  return false;
}

/** Magic-link sign-in email (login flow). Never throws. */
export async function sendMagicLink(email: string, link: string): Promise<void> {
  await deliver(
    email,
    "Your AIOS Team Brain sign-in link",
    `Click to sign in (valid 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`
  );
}

/**
 * New-member invite email. With a `link` (a one-time sign-in URL) it's a direct
 * sign-in; without one (no APP_URL configured) it's a non-secret nudge to sign in.
 * Never throws.
 */
export async function sendInviteEmail(email: string, link: string | null): Promise<void> {
  const text = link
    ? `You've been added to the AIOS Team Brain.\n\nSign in with this one-time link (single-use, expires in 24 hours):\n\n${link}\n\nIf you weren't expecting this, you can ignore this email.`
    : `You've been added to the AIOS Team Brain. Open the team brain and sign in with this email address to get started.`;
  await deliver(email, "You've been added to the AIOS Team Brain", text);
}
