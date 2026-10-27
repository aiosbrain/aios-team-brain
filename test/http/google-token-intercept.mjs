/**
 * TEST HARNESS ONLY (AIO-1167 R44 T2): preloaded into the HTTP tier's `next start` server through
 * NODE_OPTIONS by `global-setup.ts`; never imported by product code. Production code always calls
 * Google's fixed endpoints. Inside this one test server process, a request to EXACTLY one of the
 * endpoints below is answered by the loopback provider fixture named in its environment variable;
 * every other request passes through unchanged. Installed before Next.js loads, so Next's own fetch
 * wrapper wraps this one.
 */
const routes = new Map(
  [
    ["https://oauth2.googleapis.com/token", process.env.AIOS_HTTP_FAKE_GOOGLE_TOKEN_URL],
    ["https://openidconnect.googleapis.com/v1/userinfo", process.env.AIOS_HTTP_FAKE_GOOGLE_USERINFO_URL],
  ].filter(([, fixture]) => fixture),
);

if (routes.size > 0) {
  const passthrough = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const fixture = routes.get(url);
    return fixture ? passthrough(fixture, init) : passthrough(input, init);
  };
}
