// Single source of truth for the HTTP tier's server URL, imported by both the
// server (global-setup) and the clients (test files) so they always agree.
//
// NOTE: do NOT use process.env.BASE_URL — Vite reserves that name and sets it to
// its base path ("/"), which would clobber any value we put there. We derive the
// URL from HTTP_TEST_PORT (a plain numeric override, default 3010) instead.
const PORT = /^\d+$/.test(process.env.HTTP_TEST_PORT ?? "") ? process.env.HTTP_TEST_PORT! : "3010";

export const HTTP_TEST_PORT = PORT;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
