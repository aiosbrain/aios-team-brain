import "server-only";

/**
 * Magic-link delivery for the postgres backend. Uses SMTP (nodemailer) when
 * SMTP_URL is configured; otherwise logs the link to the server (dev / first-run
 * on Railway before SMTP is wired). Never throws to the caller — login UX must
 * not reveal whether delivery succeeded.
 */
export async function sendMagicLink(email: string, link: string): Promise<void> {
  const smtpUrl = process.env.SMTP_URL;
  if (!smtpUrl) {
    console.info(`[auth] magic link for ${email}: ${link}`);
    return;
  }
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(smtpUrl);
    await transport.sendMail({
      to: email,
      from: process.env.SMTP_FROM ?? "AIOS Team Brain <no-reply@aios.local>",
      subject: "Your AIOS Team Brain sign-in link",
      text: `Click to sign in (valid 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    });
  } catch (err) {
    console.error(`[auth] SMTP send failed for ${email}:`, err instanceof Error ? err.message : err);
    console.info(`[auth] magic link for ${email}: ${link}`);
  }
}
