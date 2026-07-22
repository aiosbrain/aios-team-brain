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

/**
 * Ops/admin alert email (e.g. "semantic search degraded"). Plain-text, best-effort — never throws,
 * returns whether a provider actually delivered it (false when none is configured). Not a secret, so
 * it's fine that no provider = a logged drop.
 */
export async function sendOpsAlert(to: string, subject: string, text: string): Promise<boolean> {
  return deliver(to, subject, { text });
}

/** Whether an email provider is configured at all (so callers can skip work when nothing can send). */
export function mailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_URL);
}

/**
 * The trusted base URL for building emailed links (magic links, invites), from `APP_URL` only —
 * NEVER the request Host / `x-forwarded-host`, which an attacker can spoof to point a real one-time
 * token at their own domain (account-takeover oracle). Returns null when unset: callers must then
 * skip delivery rather than email a link built against an untrusted host. This mirrors
 * `magicLinkAvailable()`, which already requires `APP_URL` before the login form offers magic-link.
 */
export function appBaseUrl(): string | null {
  const raw = process.env.APP_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : null;
}

/** Magic-link sign-in email (login flow). Never throws. */
export async function sendMagicLink(email: string, link: string): Promise<void> {
  await deliver(email, "Your AIOS Team Brain sign-in link", {
    text: `Click to sign in (valid 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}

/**
 * Whether magic-link sign-in is a real, usable option right now: a stable domain (`APP_URL`) to
 * build the link against, AND a mail provider actually configured to deliver it. Password login is
 * the default and needs neither — this only gates whether the login form offers magic-link as a
 * secondary option (`POST /api/auth/request-magic-link`). Without both, a "link sent" response would
 * be a lie (no stable link, or nothing to send it with).
 */
export function magicLinkAvailable(): boolean {
  return Boolean(process.env.APP_URL) && Boolean(process.env.RESEND_API_KEY || process.env.SMTP_URL);
}

/** Shared across the emailed invite and the manual copy-paste invite, so tone/wording match. */
function inviteExplainer(ctx: { teamName: string; inviterName: string }): string {
  return (
    `${ctx.inviterName} added you to ${ctx.teamName}'s AIOS Team Brain — your team's shared hub ` +
    `for tasks, decisions, and knowledge synced from everyone's AIOS workspace.`
  );
}

export interface InviteEmailContext {
  /** The invitee's display name, as entered by the inviter. First name is used in the greeting. */
  inviteeName: string;
  teamName: string;
  inviterName: string;
  /**
   * Ready-to-click sign-in link (single-use, 7-day magic-link token). Present whenever
   * `magicLinkAvailable()` is true — the invite flow only calls `sendInviteEmail` in that case, since
   * without a link there's nothing useful to email (the manual copy-paste path handles that case
   * instead). Kept optional here, with the old "ask your admin" copy as a defensive fallback, so this
   * function never sends a broken email if ever called without one.
   */
  loginUrl?: string;
  /**
   * Provisioning-cascade outcomes, distilled for the email's "Your team tools" section (only the
   * bits the invitee acts on). `slackInviteLink` is a standing join link the member opens themselves
   * (Slack has no invite API); `linearInvited`/`githubInvited` note that a separate invitation email
   * is on its way from that provider. All are attacker-influenced admin config, so the HTML body
   * escapes them. Omitted (or all-empty) → no tools section is rendered.
   */
  tools?: {
    slackInviteLink?: string;
    linearInvited?: boolean;
    githubInvited?: boolean;
  };
}

/**
 * New-member invite email, personalized (name/team/inviter) and carrying a one-click magic
 * sign-in link when one is available. Never throws. Names are attacker-controlled input (display
 * names), so the HTML body escapes them — this is the only place they're rendered as markup.
 */
/** Returns whether a configured mail provider accepted the message. Never throws. */
export async function sendInviteEmail(email: string, ctx: InviteEmailContext): Promise<boolean> {
  const firstName = ctx.inviteeName.trim().split(/\s+/)[0] || ctx.inviteeName;
  const subject = `${ctx.inviterName} added you to ${ctx.teamName} on AIOS`;
  const explainer = inviteExplainer(ctx);

  const textAction = ctx.loginUrl
    ? `Get started: ${ctx.loginUrl}\n\nThis link is single-use and valid for 7 days.`
    : `Ask your admin for your sign-in password, then open the team brain and sign in with this email address.`;

  const t = ctx.tools;
  const hasTools = Boolean(t && (t.slackInviteLink || t.linearInvited || t.githubInvited));
  const textToolLines: string[] = [];
  if (hasTools) {
    if (t!.slackInviteLink) textToolLines.push(`- Slack: join your team's workspace: ${t!.slackInviteLink}`);
    if (t!.linearInvited) textToolLines.push(`- Linear: a separate invitation email is on its way from Linear.`);
    if (t!.githubInvited) textToolLines.push(`- GitHub: a separate invitation email is on its way from GitHub.`);
  }
  const toolsText = hasTools ? `\n\nYour team tools:\n${textToolLines.join("\n")}` : "";
  const text = `Hi ${firstName},\n\n${explainer}\n\n${textAction}${toolsText}`;

  const safeFirstName = escapeHtml(firstName);
  const safeExplainer = escapeHtml(explainer);
  const intro = `<p>Hi ${safeFirstName},</p><p>${safeExplainer}</p>`;
  const htmlAction = ctx.loginUrl
    ? `<p><a href="${escapeHtml(ctx.loginUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Get started</a></p>
       <p style="font-size:13px;color:#666;">Or paste this link into your browser:<br>${escapeHtml(ctx.loginUrl)}</p>
       <p style="font-size:13px;color:#666;">This link is single-use and valid for 7 days.</p>`
    : `<p>Ask your admin for your sign-in password, then open the team brain and sign in with this email address.</p>`;

  let toolsHtml = "";
  if (hasTools) {
    const items: string[] = [];
    if (t!.slackInviteLink) {
      items.push(
        `<li>Slack: <a href="${escapeHtml(t!.slackInviteLink)}">join your team's workspace</a></li>`
      );
    }
    if (t!.linearInvited) items.push(`<li>Linear: a separate invitation email is on its way from Linear.</li>`);
    if (t!.githubInvited) items.push(`<li>GitHub: a separate invitation email is on its way from GitHub.</li>`);
    toolsHtml = `<p style="font-weight:600;margin:16px 0 4px;">Your team tools</p>
       <ul style="padding-left:18px;font-size:14px;color:#1a1a1a;">${items.join("")}</ul>`;
  }

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a;">
        ${intro}
        ${htmlAction}
        ${toolsHtml}
      </div>`;

  return deliver(email, subject, { text, html });
}

export interface ManualInviteContext {
  inviteeName: string;
  teamName: string;
  inviterName: string;
  teamUrl: string;
  email: string;
  password: string;
}

/**
 * Plain-text, ready-to-paste invite for admins on a deployment with no mail provider configured
 * (`!magicLinkAvailable()`) — everything the admin needs to hand a new member sign-in access via
 * Slack/DM/whatever channel they use: the team brain URL, the sign-in email, and the password.
 */
export function buildManualInviteMessage(ctx: ManualInviteContext): string {
  const firstName = ctx.inviteeName.trim().split(/\s+/)[0] || ctx.inviteeName;
  return (
    `Hi ${firstName},\n\n${inviteExplainer(ctx)}\n\n` +
    `Sign in at: ${ctx.teamUrl}\nEmail: ${ctx.email}\nPassword: ${ctx.password}`
  );
}
