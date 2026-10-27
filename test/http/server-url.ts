// Single source of truth for the HTTP tier's server URL, imported by both the
// server (global-setup) and the clients (test files) so they always agree.
//
// NOTE: do NOT use process.env.BASE_URL — Vite reserves that name and sets it to
// its base path ("/"), which would clobber any value we put there. We derive the
// URL from HTTP_TEST_PORT (a plain numeric override, default 3010) instead.
const PORT = /^\d+$/.test(process.env.HTTP_TEST_PORT ?? "") ? process.env.HTTP_TEST_PORT! : "3010";

export const HTTP_TEST_PORT = PORT;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The OAuth client the TEST server is configured with (AIO-1167 R44 T2), shared by the harness's
 *  loopback Google fixture (global-setup) and the test that drives the real start → callback flow. */
export const FAKE_GOOGLE_CLIENT = {
  id: "http-test-oauth-client",
  secret: "http-test-oauth-client-secret",
  redirect: `${BASE_URL}/api/auth/gdrive/callback`,
} as const;
