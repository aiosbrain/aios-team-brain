/**
 * TEST HARNESS ONLY (AIO-1167 R44 T2): preloaded into the HTTP tier's `next start` server through
 * NODE_OPTIONS by `global-setup.ts`; never imported by product code. Production code always calls
 * Google's fixed token endpoint. Inside this one test server process, a request to exactly that
 * endpoint is answered by the loopback provider fixture named in `AIOS_HTTP_FAKE_GOOGLE_TOKEN_URL`
 * instead; every other request passes through unchanged. Installed before Next.js loads, so Next's
 * own fetch wrapper wraps this one.
 */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const fixture = process.env.AIOS_HTTP_FAKE_GOOGLE_TOKEN_URL;

if (fixture) {
  const passthrough = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    return url === GOOGLE_TOKEN_URL ? passthrough(fixture, init) : passthrough(input, init);
  };
}
