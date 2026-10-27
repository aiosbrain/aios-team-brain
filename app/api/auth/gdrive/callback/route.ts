import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin } from "@/lib/auth/guard";
import { consumeGoogleDriveOAuthState, GDRIVE_OAUTH_BINDING_COOKIE } from "@/lib/auth/gdrive-oauth-state";
import { evaluateGdriveGrant, parseGrantedScopes, type GdriveGrantMode } from "@/lib/integrations/gdrive-grant-policy";
import {
  GoogleGrantOutsideModeError,
  IncompatibleStoredGoogleCredentialError,
  IncompleteGoogleOAuthPairError,
  GoogleIdentityConflictError,
  InvalidGoogleOAuthInitiatorError,
  publishGoogleDriveOAuthCredential,
} from "@/lib/integrations/gdrive-oauth";

export const runtime = "nodejs";

/** Per provider leg — request AND body — mirroring the broker's refresh deadline. */
const PROVIDER_DEADLINE_MS = 15_000;
const RESTART = "Start the connection again from Admin → Integrations.";

function html(status: number, heading: string, detail: string): Response {
  const safe = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safe(heading)}</title><body><main><h1>${safe(heading)}</h1><p>${safe(detail)}</p></main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

type ProviderReply =
  | { kind: "unavailable" }
  | { kind: "reply"; ok: boolean; status: number; body: Record<string, unknown> | null };

/** Settle `work` or reject when `signal` aborts, whichever comes first. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * One bounded provider call (AIO-1167 R43 F4). The deadline covers the request AND reading its body,
 * so a response that stalls after its headers cannot hold the callback open. A transport failure,
 * abort or timeout is `unavailable`; any reply is returned with its body only if that body is a JSON
 * object (null, arrays, primitives and non-JSON all read as `null`). Never retried: an authorization
 * code is single-use, and a repeated exchange is not this route's to attempt.
 */
async function providerCall(url: string, init: RequestInit): Promise<ProviderReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("provider deadline")), PROVIDER_DEADLINE_MS);
  let response: Response | null = null;
  try {
    response = await within(fetch(url, { ...init, cache: "no-store", signal: controller.signal }), controller.signal);
    let parsed: unknown = null;
    try {
      parsed = await within(response.json() as Promise<unknown>, controller.signal);
    } catch {
      if (controller.signal.aborted) return { kind: "unavailable" };
      parsed = null;
    }
    const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    return { kind: "reply", ok: response.ok, status: response.status, body };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) void response?.body?.cancel().catch(() => undefined);
  }
}

/** Google's own outage or throttling is temporary; anything else it refused is not usable. */
const temporary = (status: number) => status === 429 || status >= 500;

function unavailable(): Response {
  return html(503, "Google Drive temporarily unavailable", `Google could not be reached to finish connecting. No credentials were stored. ${RESTART}`);
}

function grantRefusal(mode: GdriveGrantMode, reason: "missing" | "insufficient" | "broader"): Response {
  if (reason === "broader") {
    return html(422, "Google granted more access than requested", mode === "files"
      ? `Google returned broader Drive access than per-file access allows — an earlier, broader grant to this app is still active for this account. No credentials were stored. Remove this app's access in your Google Account and connect again, or connect with folder discovery instead.`
      : `Google returned Drive access beyond folder discovery. No credentials were stored. Remove this app's access in your Google Account and connect again.`);
  }
  return html(422, "Google Drive connection failed", `Google did not grant the Drive access this connection needs. No credentials were stored. ${RESTART}`);
}

export async function GET(req: NextRequest) {
  const db = adminClient();
  const params = req.nextUrl.searchParams;
  // The browser first: a state is redeemed only alongside the binding cookie `start` set in the
  // browser that began this connection. Without it nothing is consumed, exchanged or stored.
  const bound = await consumeGoogleDriveOAuthState(
    db, params.get("state"), req.cookies.get(GDRIVE_OAUTH_BINDING_COOKIE)?.value,
  );
  if (!bound) return html(400, "Google Drive connection failed", "The authorization link is invalid, expired, or already used.");
  // Then the session: the Admin who started the connection must be the one signed in here, before
  // Google's code is exchanged. (Publication re-verifies that Admin once more, under its locks.)
  const session = await requireTeamAdmin(bound.teamSlug);
  if (!session || session.teamId !== bound.teamId || session.memberId !== bound.memberId) {
    return html(403, "Google Drive connection failed", "Sign in as the Admin who started this connection, then connect again. No credentials were stored.");
  }
  if (params.get("error") || !params.get("code")) return html(400, "Google Drive connection failed", "Authorization was denied. No credentials were stored.");
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT;
  if (!clientId || !clientSecret || !redirectUri) return html(503, "Google Drive unavailable", "OAuth is not configured on this instance.");

  // The state is consumed from here on: every failure below is final for this link (no retry of the
  // single-use code), bounded, sanitized, and leaves the prior connection exactly as it was.
  const exchange = await providerCall("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: params.get("code")!, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (exchange.kind === "unavailable" || (!exchange.ok && temporary(exchange.status))) return unavailable();
  const tokens = exchange.body;
  if (!exchange.ok || !tokens || typeof tokens.access_token !== "string" || !tokens.access_token) {
    return html(422, "Google Drive connection failed", `Google did not return usable credentials. No credentials were stored. ${RESTART}`);
  }
  // The grant must fit the consent mode signed into the state — checked before anything else is
  // asked of Google with it, and again by the publisher.
  const grant = evaluateGdriveGrant(bound.mode, parseGrantedScopes(tokens.scope));
  if (!grant.ok) return grantRefusal(bound.mode, grant.reason);

  const userinfo = await providerCall("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (userinfo.kind === "unavailable" || (!userinfo.ok && temporary(userinfo.status))) return unavailable();
  const user = userinfo.body ?? {};
  // The account's stable subject is what the exchange proves, and all the credential needs. Its
  // email is separate evidence: Google states it in `email_verified`, carried here as is — only the
  // literal `true` lets the publisher link the account to a member by email (AIO-1167 R41).
  const subject = typeof user.sub === "string" && user.sub ? user.sub : null;
  if (!userinfo.ok || !subject) return html(422, "Google Drive connection failed", `The connected Google account could not be verified. No credentials were stored. ${RESTART}`);
  const email = typeof user.email === "string" && user.email ? user.email : null;
  const emailVerified = user.email_verified === true;

  let status: "enabled" | "disabled";
  try {
    ({ status } = await publishGoogleDriveOAuthCredential({
      teamId: bound.teamId, memberId: bound.memberId, integrationName: bound.integrationName,
      clientId, clientSecret, subject, email, emailVerified,
      name: typeof user.name === "string" ? user.name : undefined,
      refreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : undefined,
      grantMode: bound.mode,
      scopes: grant.scopes,
    }));
  } catch (error) {
    if (error instanceof IncompleteGoogleOAuthPairError) {
      return html(422, "Google Drive reconnect required", "Google did not return a refresh credential for this account. Reconnect and grant offline access.");
    }
    if (error instanceof IncompatibleStoredGoogleCredentialError) {
      return html(422, "Google Drive reconnect required", "Google did not issue a new credential, and the stored one was granted for a different level of access, so it was not reused. The previous connection was left unchanged. Connect again; if Google still issues no new credential, remove this app's access in your Google Account first.");
    }
    if (error instanceof GoogleGrantOutsideModeError) return grantRefusal(bound.mode, error.reason);
    if (error instanceof InvalidGoogleOAuthInitiatorError) {
      return html(403, "Google Drive connection failed", "The initiating Admin is no longer authorized for this team. The previous connection was left unchanged.");
    }
    if (error instanceof GoogleIdentityConflictError) {
      return html(409, "Google identity needs review", "This verified Google account conflicts with an existing manual member mapping. Review it in Admin → Members; the previous connection was left unchanged.");
    }
    return html(500, "Google Drive connection failed", "The verified credential could not be stored. The previous connection was left unchanged.");
  }
  // Reconnecting is not Resume (R43 F2): say so when the connection is still paused.
  const paused = status === "disabled"
    ? " This connection is paused: nothing will be read until you Resume it in Admin → Integrations."
    : "";
  if (!email || !emailVerified) {
    return html(200, "Google Drive connected", `Connected ${email ?? "a Google account without an email"}. Google did not verify this account's email, so it was not linked to a member: map it under Admin → Members → Identities.${paused} Return to Integrations to choose files or folders.`);
  }
  return html(200, "Google Drive connected", `Connected ${email}.${paused} Return to Integrations to choose files or folders.`);
}
