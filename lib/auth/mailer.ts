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
  const explicit = process.env.RESEND_FROM ?? process.env.SMTP_FROM;
  if (explicit) return explicit;
  // `onboarding@resend.dev` only delivers to the Resend account owner — a footgun for real
  // invites. Warn if a key is configured but no verified sender is set.
  if (process.env.RESEND_API_KEY) {
    console.warn(
      "[mailer] RESEND_FROM unset — falling back to onboarding@resend.dev, which Resend only " +
        "delivers to the account owner. Set RESEND_FROM to a verified-domain address for real recipients."
    );
  }
  return "AIOS Team Brain <onboarding@resend.dev>";
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

  // No provider configured. NEVER log the body/link — it carries a one-time token.
  // For local sign-in without email, use /auth/dev-login (dev only).
  if (process.env.NODE_ENV !== "production") {
    console.info(`[mailer] (dev, no provider) would send "${subject}" → ${to}; set RESEND_API_KEY to deliver.`);
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
 * New-member invite courtesy email. Sign-in is email+password (the admin shares the password
 * out-of-band, the same "shown once" pattern as an API key) — this email NEVER carries a secret,
 * it's just a heads-up that an account exists. Never throws.
 */
export async function sendInviteEmail(email: string): Promise<void> {
  await deliver(
    email,
    "You've been added to the AIOS Team Brain",
    "You've been added to the AIOS Team Brain. Ask your admin for your sign-in password, then " +
      "open the team brain and sign in with this email address."
  );
}
