import { type NextRequest, NextResponse } from "next/server";
import { ensureAuthUser, linkMemberByEmail } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";
import { safeNextPath } from "@/lib/auth/next-path";

export const runtime = "nodejs";

/**
 * The only authorities this route answers, matched against the RAW header text — never a
 * URL-canonicalized form, which would fold `127.1`, `0x7f.0.0.1`, `2130706433` and a trailing dot
 * onto the loopback names. A port, when present, is canonical decimal (range-checked below).
 * No `u` flag on purpose: without it, `i` never folds a non-ASCII character onto an ASCII one.
 */
const LOCAL_AUTHORITY = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/i;
const LOCAL_URL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_PORT = { http: 80, https: 443 } as const;

function parseLocalAuthority(raw: string | null): { hostname: string; port: number | null } | null {
  const match = raw === null ? null : LOCAL_AUTHORITY.exec(raw);
  if (!match) return null;
  const hostname = match[1].toLowerCase();
  if (match[2] === undefined) return { hostname, port: null };
  const port = Number(match[2]);
  return port <= 65535 ? { hostname, port } : null;
}

/**
 * The request's validated local authority: its parsed URL and the redirect base. Null when any rule
 * fails. A Host header is the authority the client ASKED for, not the peer it connected from.
 */
function localAuthority(request: NextRequest): { url: URL; base: URL } | null {
  // Host is the header itself — x-forwarded-host and request.url are never substitutes for it.
  const host = parseLocalAuthority(request.headers.get("host"));
  if (!host) return null;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const scheme = url.protocol === "http:" ? "http" : url.protocol === "https:" ? "https" : null;
  if (scheme === null) return null;
  if (url.username !== "" || url.password !== "") return null;
  // Next dev reports request.url as localhost even when the browser is on 127.0.0.1, so the URL may
  // name a different loopback alias than Host — but a public URL is never made local by its headers.
  if (!LOCAL_URL_HOSTNAMES.has(url.hostname)) return null;
  // Same effective port on both: a remapped/published port (Host port ≠ server port) is refused.
  const port = host.port ?? DEFAULT_PORT[scheme];
  if (port !== (url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port))) return null;

  // Forwarded headers add no authority. Next populates them itself, so PRESENT (even empty) ones
  // must agree with Host and the URL scheme; a list, another alias or a public value is refused.
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost !== null) {
    const forwarded = parseLocalAuthority(forwardedHost);
    if (!forwarded || forwarded.hostname !== host.hostname || (forwarded.port ?? DEFAULT_PORT[scheme]) !== port) {
      return null;
    }
  }
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto !== null && forwardedProto !== scheme) return null;

  // Stay on the host the caller used (cookie is host-only): built from the validated Host and
  // scheme only, never from a forwarded value.
  return { url, base: new URL(`${scheme}://${host.hostname}:${port}`) };
}

function refuse(): NextResponse {
  return new NextResponse("dev-login is disabled", { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * LOCAL-DEVELOPMENT one-click login. Start ONE server with `npm run dev:login`
 * (AIOS_DEV_LOGIN=1, bound to 127.0.0.1), then visit on that same host and port:
 *   /auth/dev-login?email=alex@demo.aios.local&next=/t/demo
 *
 * Mints AND sets the session for ANY email in a single server request, with no credential check —
 * so it answers only a deliberate local setup. In order, before any identity write or signing:
 *   1. never in production — the literal check below, which `next build` substitutes, so a
 *      production artifact refuses under any runtime NODE_ENV;
 *   2. only with the exact request-time opt-in AIOS_DEV_LOGIN=1 (default off; nothing else counts);
 *   3. only for a strictly local request authority (`localAuthority`);
 *   4. only to a same-origin path on that authority (`safeNextPath`, then the origin check).
 * Every refusal is the same inert 404: constant body, no-store, no Location, no cookie, no log.
 *
 * These checks do not identify the peer: a client that can reach an enabled listener can send a
 * local Host. Keep the listener on loopback, and never enable this against a shared, staging or
 * production database or AUTH_SECRET — a session signed here is valid wherever that secret is.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return refuse();
  }
  if (process.env.AIOS_DEV_LOGIN !== "1") {
    return refuse();
  }
  const local = localAuthority(request);
  if (!local) return refuse();

  const { searchParams } = local.url;
  const email = searchParams.get("email") || "alex@demo.aios.local";
  const safeNext = safeNextPath(searchParams.get("next") ?? "/t/demo");
  const destination = new URL(safeNext, local.base);
  if (destination.origin !== local.base.origin) return refuse();

  // Create the local auth user, link the member, set the signed session cookie.
  const id = await ensureAuthUser(email);
  await linkMemberByEmail(id, email);
  const token = await signSession({ id, email });
  const res = NextResponse.redirect(destination);
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
