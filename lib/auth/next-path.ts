import "server-only";

/**
 * Sanitize a post-login redirect target: only a same-origin absolute path is allowed, anything
 * else collapses to "/". A naive `startsWith("/") && !startsWith("//")` check is NOT enough — the
 * WHATWG URL parser treats a backslash as a slash and strips ASCII tab/newline before parsing, so
 * `/\evil.com` and `/\t/evil.com` both resolve to an off-origin host. We validate by actually
 * parsing against a throwaway origin and rejecting anything that lands off it, then return the
 * parser-normalized path so the caller feeds `new URL()` the exact string we validated.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  try {
    const base = "https://internal.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return "/";
    const path = u.pathname + u.search + u.hash;
    // `new URL` can collapse e.g. `/..//evil.com` to the protocol-relative `//evil.com`, which stays
    // same-origin under this dummy base but navigates OFF-origin the moment it's assigned to
    // `window.location.href` (login) or resolved against the real host (confirm). Reject it so the
    // function is idempotent — its own output always re-validates to itself.
    return path.startsWith("//") ? "/" : path;
  } catch {
    return "/";
  }
}
