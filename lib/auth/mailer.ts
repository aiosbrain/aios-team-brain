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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function deliver(to: string, subject: string, body: { text: string; html?: string }): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: senderFrom(),
          to,
          subject,
          text: body.text,
          ...(body.html ? { html: body.html } : {}),
        }),
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
      await transport.sendMail({
        to,
        from: senderFrom(),
        subject,
        text: body.text,
        ...(body.html ? { html: body.html } : {}),
      });
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
  await deliver(email, "Your AIOS Team Brain sign-in link", {
    text: `Click to sign in (valid 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}

export interface InviteEmailContext {
  /** The invitee's display name, as entered by the inviter. First name is used in the greeting. */
  inviteeName: string;
  teamName: string;
  inviterName: string;
}

/**
 * New-member invite courtesy email, personalized (name/team/inviter). Sign-in is email+password
 * (the admin shares the password out-of-band, the same "shown once" pattern as an API key) — this
 * email NEVER carries a secret, it's just a heads-up that an account exists. Never throws. Names
 * are attacker-controlled input (display names), so the HTML body escapes them — this is the only
 * place they're rendered as markup.
 */
export async function sendInviteEmail(email: string, ctx: InviteEmailContext): Promise<void> {
  const firstName = ctx.inviteeName.trim().split(/\s+/)[0] || ctx.inviteeName;
  const subject = `${ctx.inviterName} added you to ${ctx.teamName} on AIOS`;

  const text =
    `Hi ${firstName},\n\n${ctx.inviterName} added you to ${ctx.teamName}'s AIOS Team Brain.\n\n` +
    `Ask your admin for your sign-in password, then open the team brain and sign in with this email address.`;

  const safeFirstName = escapeHtml(firstName);
  const safeInviter = escapeHtml(ctx.inviterName);
  const safeTeam = escapeHtml(ctx.teamName);
  const intro = `<p>Hi ${safeFirstName},</p><p><strong>${safeInviter}</strong> added you to <strong>${safeTeam}</strong>'s AIOS Team Brain.</p>`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a;">
        ${intro}
        <p>Ask your admin for your sign-in password, then open the team brain and sign in with this email address.</p>
      </div>`;

  await deliver(email, subject, { text, html });
}
