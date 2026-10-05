import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseSetCookie } from "./http/dev-login-dev-setup";

// Spec (AIO-1210, docs/design/aio1210-dev-login.md): dev-login mints a session for ANY email with no
// credential check, so it must be reachable only deliberately. Admission order:
//
//   production guard → exact opt-in (AIOS_DEV_LOGIN === "1") → strictly local Host / request URL /
//   forwarded authority → safe redirect preparation → ensureAuthUser → linkMemberByEmail → signSession
//
// Every refusal is the same inert response — 404, the constant body, `Cache-Control: no-store`, no
// Location, no Set-Cookie — and makes NO privileged call. The three privileged calls are named spies
// with functioning admitted outputs, so a request the handler wrongly admits shows up as what it is
// (a 307 with a session cookie and three calls), not as a missing-database throw.
//
// Handler-visible contract these cases pin: the handler reads `request.url` and `request.headers`
// only. Most cases therefore pass exactly those two, with a real `Headers` (so its normalisation is
// the real one) and a literal URL string — the only way to present a URL the framework would never
// hand over (credentials, another scheme, a public host) or would rewrite (a real NextRequest exposes
// every loopback URL host as `localhost`). The exposed header value is asserted before the outcome.
const auth = vi.hoisted(() => ({
  ensureAuthUser: vi.fn<(email: string) => Promise<string>>(),
  linkMemberByEmail: vi.fn<(authUserId: string, email: string, teamId?: string | null) => Promise<void>>(),
  signSession: vi.fn<(user: { id: string; email: string }) => Promise<string>>(),
}));

vi.mock("@/lib/auth/pg-login", () => ({
  ensureAuthUser: auth.ensureAuthUser,
  linkMemberByEmail: auth.linkMemberByEmail,
}));
vi.mock("@/lib/auth/pg-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/pg-session")>()),
  signSession: auth.signSession,
}));

const { GET } = await import("@/app/auth/dev-login/route");
const { SESSION_COOKIE, SESSION_MAX_AGE_S } = await import("@/lib/auth/pg-session");

const DISABLED_BODY = "dev-login is disabled";
const DEFAULT_EMAIL = "alex@demo.aios.local";
const AUTH_USER_ID = "00000000-0000-4000-8000-00000000a001";
const TOKEN = "example.session.token";
const PATH = "/auth/dev-login";
const LOCAL_URL = `http://localhost:3000${PATH}`;
const LOCAL_HOST = "localhost:3000";

/** Exactly what the handler may read: a URL string and real Headers. */
function visible(url: string, headers: Record<string, string>): NextRequest {
  return { url, headers: new Headers(headers) } as unknown as NextRequest;
}

function query(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q ? `?${q}` : "";
}

/** A request with a strictly local authority, optionally varied. `host: null` sends no Host. */
function local(
  opts: { params?: Record<string, string>; host?: string | null; headers?: Record<string, string>; url?: string } = {}
): NextRequest {
  const host = opts.host === undefined ? LOCAL_HOST : opts.host;
  return visible(`${opts.url ?? LOCAL_URL}${query(opts.params ?? {})}`, {
    ...(host === null ? {} : { host }),
    ...(opts.headers ?? {}),
  });
}

function runtime(nodeEnv: string | undefined, optIn: string | undefined, obsoleteOptIn?: string): void {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("AIOS_DEV_LOGIN", optIn);
  vi.stubEnv("ALLOW_DEV_LOGIN", obsoleteOptIn);
  // The fixture itself, checked before any GET: a requested `undefined` is a genuinely ABSENT
  // variable (not the string "undefined", not a leftover value), so the "unset" and "missing" cases
  // below test what they say they test.
  for (const [name, value] of [
    ["NODE_ENV", nodeEnv],
    ["AIOS_DEV_LOGIN", optIn],
  ] as const) {
    if (value === undefined) expect(name in process.env, `${name} must be absent`).toBe(false);
    else expect(process.env[name]).toBe(value);
  }
}
/** The deliberate local configuration: a non-production mode with the exact opt-in. */
const enabled = (): void => runtime("development", "1");

function expectNoPrivilegedCalls(): void {
  expect.soft(auth.ensureAuthUser).toHaveBeenCalledTimes(0);
  expect.soft(auth.linkMemberByEmail).toHaveBeenCalledTimes(0);
  expect.soft(auth.signSession).toHaveBeenCalledTimes(0);
}

/** Inert: the handler's own 404, nothing that could carry a session, nothing privileged touched. */
async function expectInert(res: Response): Promise<void> {
  expect.soft(res.status).toBe(404);
  expect.soft(await res.text()).toBe(DISABLED_BODY);
  expect.soft(res.headers.get("location")).toBeNull();
  expect.soft(res.headers.getSetCookie()).toEqual([]);
  expectNoPrivilegedCalls();
}

/** The full refusal contract: inert AND explicitly uncacheable. */
async function expectRefusal(res: Response): Promise<void> {
  await expectInert(res);
  expect.soft(res.headers.get("cache-control")).toBe("no-store");
}

/** ensure → link → sign, exactly once each, for `email`, with no team context for the linker. */
function expectPrivilegedSequence(email: string): void {
  expect(auth.ensureAuthUser).toHaveBeenCalledTimes(1);
  expect(auth.ensureAuthUser).toHaveBeenCalledWith(email);
  expect(auth.linkMemberByEmail).toHaveBeenCalledTimes(1);
  const linkArgs = auth.linkMemberByEmail.mock.calls[0];
  expect(linkArgs.slice(0, 2)).toEqual([AUTH_USER_ID, email]);
  // No teamId: the linker links identity only and never activates an invited row from this route.
  expect(linkArgs[2] ?? null).toBeNull();
  expect(auth.signSession).toHaveBeenCalledTimes(1);
  expect(auth.signSession).toHaveBeenCalledWith({ id: AUTH_USER_ID, email });
  const [ensured] = auth.ensureAuthUser.mock.invocationCallOrder;
  const [linked] = auth.linkMemberByEmail.mock.invocationCallOrder;
  const [signed] = auth.signSession.mock.invocationCallOrder;
  expect(ensured).toBeLessThan(linked);
  expect(linked).toBeLessThan(signed);
}

/** Admitted: 307 to `origin` + `target`, the signed token in the session cookie, the full sequence. */
function expectAdmitted(res: Response, expected: { origin: string; target?: string; email?: string }): void {
  expect(res.status).toBe(307);
  const location = res.headers.get("location");
  expect(location).not.toBeNull();
  // The ACTUAL destination origin, never a substring of the header.
  const destination = new URL(String(location));
  expect(destination.origin).toBe(expected.origin);
  expect(destination.pathname + destination.search + destination.hash).toBe(expected.target ?? "/t/demo");
  const cookies = res.headers.getSetCookie().map(parseSetCookie);
  expect(cookies.map((cookie) => cookie.name)).toEqual([SESSION_COOKIE]);
  expect(cookies[0].value).toBe(TOKEN);
  expectPrivilegedSequence(expected.email ?? DEFAULT_EMAIL);
}

beforeEach(() => {
  auth.ensureAuthUser.mockReset().mockName("ensureAuthUser").mockResolvedValue(AUTH_USER_ID);
  auth.linkMemberByEmail.mockReset().mockName("linkMemberByEmail").mockResolvedValue(undefined);
  auth.signSession.mockReset().mockName("signSession").mockResolvedValue(TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── AC01 — production hard-off ──────────────────────────────────────────────────────────────────

describe("GET /auth/dev-login — production hard-off (AC01)", () => {
  it("production denies even with both opt-ins and a valid local authority", async () => {
    runtime("production", "1", "1");
    await expectInert(await GET(local({ params: { email: DEFAULT_EMAIL } })));
  });

  it("production denies with only the obsolete ALLOW_DEV_LOGIN escape", async () => {
    // Previously ALLOW_DEV_LOGIN=1 re-enabled this in prod — it must never have any effect again.
    runtime("production", undefined, "1");
    await expectInert(await GET(local({ params: { email: DEFAULT_EMAIL } })));
  });

  it("production denies whatever the authority looks like, matching forwarding included", async () => {
    runtime("production", "1", "1");
    await expectInert(
      await GET(local({ headers: { "x-forwarded-host": LOCAL_HOST, "x-forwarded-proto": "http" } }))
    );
  });

  it("production denial never touches unavailable auth dependencies", async () => {
    runtime("production", "1", "1");
    auth.ensureAuthUser.mockRejectedValue(new Error("DB_BACKEND=postgres requires DATABASE_URL to be set"));
    auth.signSession.mockRejectedValue(new Error("requires AUTH_SECRET"));
    await expectInert(await GET(local()));
  });

  it("production denial is explicitly no-store", async () => {
    runtime("production", "1", "1");
    const res = await GET(local());
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ── AC02 — exact, default-off opt-in ────────────────────────────────────────────────────────────

describe("GET /auth/dev-login — exact default-off opt-in (AC02)", () => {
  const MODES: { mode: string; nodeEnv: string | undefined }[] = [
    { mode: "development", nodeEnv: "development" },
    { mode: "test", nodeEnv: "test" },
    { mode: "unset", nodeEnv: undefined },
  ];
  const NOT_OPT_IN: { label: string; optIn: string | undefined }[] = [
    { label: "missing", optIn: undefined },
    { label: "empty", optIn: "" },
    { label: "0", optIn: "0" },
    { label: "true", optIn: "true" },
    { label: "a single space", optIn: " " },
    { label: "1 with a leading space", optIn: " 1" },
    { label: "1 with a trailing space", optIn: "1 " },
    { label: "1 with a trailing newline", optIn: "1\n" },
    { label: "01", optIn: "01" },
    { label: "yes", optIn: "yes" },
  ];

  describe.each(MODES)("NODE_ENV $mode", ({ nodeEnv }) => {
    it.each(NOT_OPT_IN)("nonproduction without exact opt-in is inert: AIOS_DEV_LOGIN $label", async ({ optIn }) => {
      runtime(nodeEnv, optIn);
      await expectRefusal(await GET(local({ params: { email: DEFAULT_EMAIL } })));
    });

    it("the obsolete ALLOW_DEV_LOGIN=1 is not an opt-in", async () => {
      runtime(nodeEnv, undefined, "1");
      await expectRefusal(await GET(local()));
    });

    it("valid local input with exact AIOS_DEV_LOGIN=1 admits", async () => {
      runtime(nodeEnv, "1");
      expectAdmitted(await GET(local()), { origin: "http://localhost:3000" });
    });
  });

  it("the opt-in is read per request, never cached at module load", async () => {
    runtime("development", "1");
    expect((await GET(local())).status).toBe(307);

    runtime("development", "0");
    auth.ensureAuthUser.mockClear();
    auth.linkMemberByEmail.mockClear();
    auth.signSession.mockClear();
    await expectRefusal(await GET(local()));

    runtime("development", "1");
    expect((await GET(local())).status).toBe(307);
  });

  it("all policy refusals are inert even with unavailable auth dependencies", async () => {
    auth.ensureAuthUser.mockRejectedValue(new Error("DB_BACKEND=postgres requires DATABASE_URL to be set"));
    auth.linkMemberByEmail.mockRejectedValue(new Error("DB_BACKEND=postgres requires DATABASE_URL to be set"));
    auth.signSession.mockRejectedValue(new Error("requires AUTH_SECRET"));

    runtime("development", undefined);
    await expectRefusal(await GET(local()));

    runtime("development", "1");
    await expectRefusal(await GET(local({ host: "evil.example:3000" })));
    await expectRefusal(await GET(local({ headers: { "x-forwarded-host": "evil.example" } })));
    await expectRefusal(await GET(local({ url: `http://evil.example:3000${PATH}` })));
  });
});

// ── AC03 — raw Host boundary ────────────────────────────────────────────────────────────────────

describe("GET /auth/dev-login — raw Host boundary (AC03)", () => {
  // `sent` is what the client set; `seen` is what Headers exposes to the handler.
  const ADMITTED: { label: string; sent: string; seen?: string; url: string; origin: string }[] = [
    { label: "localhost with a port", sent: "localhost:3000", url: LOCAL_URL, origin: "http://localhost:3000" },
    { label: "LOCALHOST (ASCII case-insensitive)", sent: "LOCALHOST:3000", url: LOCAL_URL, origin: "http://localhost:3000" },
    { label: "LocalHost (mixed case)", sent: "LocalHost:3000", url: LOCAL_URL, origin: "http://localhost:3000" },
    { label: "127.0.0.1 with a port", sent: "127.0.0.1:3000", url: LOCAL_URL, origin: "http://127.0.0.1:3000" },
    { label: "bracketed [::1] with a port", sent: "[::1]:3000", url: LOCAL_URL, origin: "http://[::1]:3000" },
    { label: "lowest legitimate port 1", sent: "localhost:1", url: `http://localhost:1${PATH}`, origin: "http://localhost:1" },
    {
      label: "highest legitimate port 65535",
      sent: "127.0.0.1:65535",
      url: `http://localhost:65535${PATH}`,
      origin: "http://127.0.0.1:65535",
    },
    { label: "no port under http (default 80)", sent: "localhost", url: `http://localhost${PATH}`, origin: "http://localhost" },
    { label: "explicit :80 under http", sent: "localhost:80", url: `http://localhost${PATH}`, origin: "http://localhost" },
    { label: "no port under https (default 443)", sent: "127.0.0.1", url: `https://localhost${PATH}`, origin: "https://127.0.0.1" },
    { label: "explicit :443 under https", sent: "[::1]:443", url: `https://localhost${PATH}`, origin: "https://[::1]" },
    {
      label: "surrounding whitespace that Headers trims before the handler sees it",
      sent: "  localhost:3000  ",
      seen: "localhost:3000",
      url: LOCAL_URL,
      origin: "http://localhost:3000",
    },
  ];

  it.each(ADMITTED)("strict loopback authorities admit: $label", async ({ sent, seen, url, origin }) => {
    enabled();
    const request = visible(url, { host: sent });
    expect(request.headers.get("host")).toBe(seen ?? sent);
    expectAdmitted(await GET(request), { origin });
  });

  const REFUSED: { label: string; host: string }[] = [
    { label: "an empty Host", host: "" },
    { label: "a nonlocal host", host: "evil.example" },
    { label: "a nonlocal host with the right port", host: "evil.example:3000" },
    { label: "a suffix lookalike", host: "localhost.evil.example:3000" },
    { label: "a prefix lookalike", host: "evil-localhost:3000" },
    { label: "a longer lookalike", host: "notlocalhost:3000" },
    { label: "a trailing dot", host: "localhost.:3000" },
    { label: "a subdomain of localhost", host: "sub.localhost:3000" },
    { label: "a numeric suffix lookalike", host: "127.0.0.1.evil.example:3000" },
    { label: "a trailing dot on the IPv4 literal", host: "127.0.0.1.:3000" },
    { label: "the short numeric form 127.1", host: "127.1:3000" },
    { label: "another loopback address", host: "127.0.0.2:3000" },
    { label: "a zero-padded octet", host: "127.0.0.01:3000" },
    { label: "the wildcard address", host: "0.0.0.0:3000" },
    { label: "the decimal integer form", host: "2130706433:3000" },
    { label: "the hex octet form", host: "0x7f.0.0.1:3000" },
    { label: "the octal octet form", host: "0177.0.0.1:3000" },
    { label: "unbracketed IPv6 loopback", host: "::1" },
    { label: "unbracketed IPv6 loopback with a port", host: "::1:3000" },
    { label: "expanded IPv6 loopback", host: "[0:0:0:0:0:0:0:1]:3000" },
    { label: "IPv6 loopback with a zone id", host: "[::1%lo0]:3000" },
    { label: "IPv4-mapped IPv6 loopback", host: "[::ffff:127.0.0.1]:3000" },
    { label: "userinfo before the host", host: "user@localhost:3000" },
    { label: "userinfo with a password", host: "user:pass@localhost:3000" },
    { label: "the local authority as userinfo of a public host", host: "localhost:3000@evil.example" },
    { label: "interior whitespace in the hostname", host: "local host:3000" },
    { label: "whitespace before the port colon", host: "localhost :3000" },
    { label: "whitespace after the port colon", host: "localhost: 3000" },
    { label: "an interior tab", host: "localhost\t:3000" },
    { label: "a comma list ending in a public host", host: "localhost:3000, evil.example" },
    { label: "a comma list of two local values", host: "localhost:3000,localhost:3000" },
    { label: "a trailing slash", host: "localhost:3000/" },
    { label: "a path", host: "localhost:3000/path" },
    { label: "a query", host: "localhost:3000?x=1" },
    { label: "a fragment", host: "localhost:3000#frag" },
    { label: "a backslash", host: "localhost:3000\\evil.example" },
    { label: "an empty port", host: "localhost:" },
    { label: "a signed port (+)", host: "localhost:+3000" },
    { label: "a signed port (-)", host: "localhost:-3000" },
    { label: "port zero", host: "localhost:0" },
    { label: "a leading-zero port", host: "localhost:03000" },
    { label: "port 65536", host: "localhost:65536" },
    { label: "a six-digit port", host: "localhost:100000" },
    { label: "an exponent port", host: "localhost:3e3" },
    { label: "a hex port", host: "localhost:0xbb8" },
    { label: "a decimal-point port", host: "localhost:3000.0" },
    { label: "an extra colon and port", host: "localhost:3000:3000" },
    { label: "a doubled colon", host: "localhost::3000" },
  ];

  it.each(REFUSED)("every unsupported authority is inert: $label", async ({ host }) => {
    enabled();
    const request = local({ host });
    // Genuinely what the handler sees — not something Headers normalised into a valid value.
    expect(request.headers.get("host")).toBe(host);
    await expectRefusal(await GET(request));
  });

  it("a missing Host denies", async () => {
    enabled();
    const request = local({ host: null });
    expect(request.headers.has("host")).toBe(false);
    await expectRefusal(await GET(request));
  });

  it("a missing Host is not replaced by x-forwarded-host or by the request URL", async () => {
    enabled();
    await expectRefusal(await GET(local({ host: null, headers: { "x-forwarded-host": LOCAL_HOST } })));
  });

  it("forwarded-for claims never turn a nonlocal Host into an admitted one", async () => {
    enabled();
    await expectRefusal(
      await GET(
        local({
          host: "evil.example:3000",
          headers: {
            "x-forwarded-for": "127.0.0.1",
            forwarded: "for=127.0.0.1;host=localhost:3000;proto=http",
            "x-real-ip": "127.0.0.1",
          },
        })
      )
    );
  });

  it("forwarded-for, RFC Forwarded and x-forwarded-port are not authorities: a local request stays admitted on its Host", async () => {
    enabled();
    const res = await GET(
      local({
        headers: {
          "x-forwarded-for": "203.0.113.9",
          forwarded: "for=203.0.113.9;host=evil.example;proto=https",
          "x-forwarded-port": "9999",
        },
      })
    );
    expectAdmitted(res, { origin: "http://localhost:3000" });
  });

  it("a real NextRequest exposes a 127.0.0.1 URL as localhost and is admitted on its raw Host", async () => {
    enabled();
    const request = new NextRequest(`http://127.0.0.1:3000${PATH}`, { headers: { host: "127.0.0.1:3000" } });
    // Framework normalisation the alias rule exists for: literal host equality is not required.
    expect(new URL(request.url).hostname).toBe("localhost");
    expect(request.headers.get("host")).toBe("127.0.0.1:3000");
    expectAdmitted(await GET(request), { origin: "http://127.0.0.1:3000" });
  });
});

// ── AC04 — request URL and forwarded consistency ────────────────────────────────────────────────

describe("GET /auth/dev-login — URL and forwarded consistency (AC04)", () => {
  const URL_REFUSED: { label: string; url: string; host?: string }[] = [
    { label: "an ftp scheme", url: `ftp://localhost:3000${PATH}` },
    { label: "a ws scheme", url: `ws://localhost:3000${PATH}` },
    { label: "a file URL", url: `file://${PATH}` },
    { label: "URL credentials (user and password)", url: `http://user:pass@localhost:3000${PATH}` },
    { label: "URL credentials (user only)", url: `http://user@localhost:3000${PATH}` },
    { label: "a public URL host on the same port", url: `http://evil.example:3000${PATH}` },
    { label: "a public URL host on the default port", url: `http://evil.example${PATH}`, host: "localhost" },
    { label: "the wildcard URL host 0.0.0.0", url: `http://0.0.0.0:3000${PATH}` },
    { label: "another loopback URL address", url: `http://127.0.0.2:3000${PATH}` },
    { label: "a lookalike URL host", url: `http://localhost.evil.example:3000${PATH}` },
    { label: "a trailing-dot URL host", url: `http://localhost.:3000${PATH}` },
    { label: "an IPv4-mapped IPv6 URL host", url: `http://[::ffff:127.0.0.1]:3000${PATH}` },
    { label: "a URL port that differs from the Host port", url: `http://localhost:3001${PATH}` },
    { label: "a default-port URL against a Host on 3000", url: `http://localhost${PATH}` },
    { label: "a URL on 3000 against a port-less Host (effective 80)", url: LOCAL_URL, host: "localhost" },
    { label: "an https URL on 3000 against a port-less Host (effective 443)", url: `https://localhost:3000${PATH}`, host: "localhost" },
    { label: "an https default-port URL against Host :80", url: `https://localhost${PATH}`, host: "localhost:80" },
    { label: "an unparseable URL", url: "not a url" },
    { label: "an empty URL", url: "" },
    { label: "a relative URL", url: PATH },
    { label: "a scheme with no authority", url: "http://" },
    { label: "an unterminated IPv6 URL host", url: `http://[::1${PATH}` },
  ];

  it.each(URL_REFUSED)("public URL or contradictory forwarding cannot grant or redirect a session: $label", async ({ url, host }) => {
    enabled();
    // A parse failure is a refusal like any other, never a thrown error.
    await expectRefusal(await GET(visible(url, { host: host ?? LOCAL_HOST })));
  });

  const URL_ALIASES: { label: string; url: string; host: string; origin: string }[] = [
    { label: "URL 127.0.0.1, Host localhost", url: `http://127.0.0.1:3000${PATH}`, host: "localhost:3000", origin: "http://localhost:3000" },
    { label: "URL [::1], Host 127.0.0.1", url: `http://[::1]:3000${PATH}`, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    { label: "URL localhost, Host [::1]", url: LOCAL_URL, host: "[::1]:3000", origin: "http://[::1]:3000" },
    { label: "URL upper-case LOCALHOST", url: `http://LOCALHOST:3000${PATH}`, host: "localhost:3000", origin: "http://localhost:3000" },
    { label: "https URL 127.0.0.1, Host localhost", url: `https://127.0.0.1:3000${PATH}`, host: "localhost:3000", origin: "https://localhost:3000" },
    { label: "https default port, Host :443", url: `https://localhost${PATH}`, host: "localhost:443", origin: "https://localhost" },
    // The URL rule reads the PARSED hostname (the parser canonicalises 127.1 to 127.0.0.1); the Host
    // rule is lexical, so the same spelling as a raw Host is refused above ("the short numeric form").
    { label: "URL short numeric 127.1, canonical Host 127.0.0.1", url: `http://127.1:3000${PATH}`, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
  ];

  it.each(URL_ALIASES)("local URL aliases with an equal effective port admit on the raw Host: $label", async ({ url, host, origin }) => {
    enabled();
    expectAdmitted(await GET(visible(url, { host })), { origin });
  });

  const FORWARDED_HOST_ADMITTED: { label: string; url: string; host: string; forwarded: string; origin: string }[] = [
    { label: "identical to Host", url: LOCAL_URL, host: "localhost:3000", forwarded: "localhost:3000", origin: "http://localhost:3000" },
    { label: "the same hostname in another case", url: LOCAL_URL, host: "localhost:3000", forwarded: "LOCALHOST:3000", origin: "http://localhost:3000" },
    { label: "identical bracketed IPv6", url: LOCAL_URL, host: "[::1]:3000", forwarded: "[::1]:3000", origin: "http://[::1]:3000" },
    { label: "explicit default port against a port-less Host", url: `http://localhost${PATH}`, host: "localhost", forwarded: "localhost:80", origin: "http://localhost" },
  ];

  it.each(FORWARDED_HOST_ADMITTED)("a matching x-forwarded-host adds no authority and admits: $label", async ({ url, host, forwarded, origin }) => {
    enabled();
    expectAdmitted(await GET(visible(url, { host, "x-forwarded-host": forwarded })), { origin });
  });

  const FORWARDED_HOST_REFUSED: { label: string; forwarded: string }[] = [
    { label: "a public host", forwarded: "evil.example" },
    { label: "a public host on the same port", forwarded: "evil.example:3000" },
    { label: "a different loopback alias (127.0.0.1)", forwarded: "127.0.0.1:3000" },
    { label: "a different loopback alias ([::1])", forwarded: "[::1]:3000" },
    { label: "a different port", forwarded: "localhost:3001" },
    { label: "no port (effective 80)", forwarded: "localhost" },
    { label: "a list of two identical values", forwarded: "localhost:3000, localhost:3000" },
    { label: "a list ending in a public host", forwarded: "localhost:3000, evil.example" },
    { label: "a list starting with a public host", forwarded: "evil.example, localhost:3000" },
    { label: "a leading-zero port", forwarded: "localhost:03000" },
    { label: "a trailing slash", forwarded: "localhost:3000/" },
    { label: "userinfo", forwarded: "user@localhost:3000" },
    { label: "a trailing dot", forwarded: "localhost.:3000" },
    { label: "present but empty", forwarded: "" },
  ];

  it.each(FORWARDED_HOST_REFUSED)("a contradictory or malformed x-forwarded-host denies: $label", async ({ forwarded }) => {
    enabled();
    const request = local({ headers: { "x-forwarded-host": forwarded } });
    expect(request.headers.get("x-forwarded-host")).toBe(forwarded);
    await expectRefusal(await GET(request));
  });

  it("a raw public Host stays denied whatever local forwarding accompanies it", async () => {
    enabled();
    await expectRefusal(await GET(local({ host: "evil.example:3000", headers: { "x-forwarded-host": LOCAL_HOST } })));
    await expectRefusal(
      await GET(
        local({
          host: "evil.example",
          headers: { "x-forwarded-host": LOCAL_HOST, "x-forwarded-proto": "http", "x-forwarded-port": "3000" },
        })
      )
    );
  });

  it.each([
    { label: "http on an http URL", url: LOCAL_URL, proto: "http", origin: "http://localhost:3000" },
    { label: "https on an https URL", url: `https://localhost:3000${PATH}`, proto: "https", origin: "https://localhost:3000" },
  ])("a matching x-forwarded-proto admits: $label", async ({ url, proto, origin }) => {
    enabled();
    expectAdmitted(await GET(visible(url, { host: LOCAL_HOST, "x-forwarded-proto": proto })), { origin });
  });

  const FORWARDED_PROTO_REFUSED: { label: string; url: string; proto: string }[] = [
    { label: "https against an http URL", url: LOCAL_URL, proto: "https" },
    { label: "http against an https URL", url: `https://localhost:3000${PATH}`, proto: "http" },
    { label: "another scheme", url: LOCAL_URL, proto: "ftp" },
    { label: "upper-case HTTP", url: LOCAL_URL, proto: "HTTP" },
    { label: "mixed-case Https on an https URL", url: `https://localhost:3000${PATH}`, proto: "Https" },
    { label: "a trailing colon", url: LOCAL_URL, proto: "http:" },
    { label: "a scheme with slashes", url: LOCAL_URL, proto: "http://" },
    { label: "a list http,https", url: LOCAL_URL, proto: "http,https" },
    { label: "a list https, http on an https URL", url: `https://localhost:3000${PATH}`, proto: "https, http" },
    { label: "a list of two identical values", url: LOCAL_URL, proto: "http, http" },
    { label: "two space-separated values", url: LOCAL_URL, proto: "http https" },
    { label: "present but empty", url: LOCAL_URL, proto: "" },
  ];

  it.each(FORWARDED_PROTO_REFUSED)("a mismatched, listed or malformed x-forwarded-proto denies: $label", async ({ url, proto }) => {
    enabled();
    const request = visible(url, { host: LOCAL_HOST, "x-forwarded-proto": proto });
    expect(request.headers.get("x-forwarded-proto")).toBe(proto);
    await expectRefusal(await GET(request));
  });
});

// ── AC05 — local, safe redirect ─────────────────────────────────────────────────────────────────

describe("GET /auth/dev-login — local safe redirect (AC05)", () => {
  const HOSTS: { host: string; origin: string }[] = [
    { host: "localhost:3000", origin: "http://localhost:3000" },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    { host: "[::1]:3000", origin: "http://[::1]:3000" },
  ];
  // `next: undefined` omits the parameter. Targets are what the existing safeNextPath contract yields.
  const NEXT: { label: string; next: string | undefined; target: string }[] = [
    { label: "absent → the /t/demo default", next: undefined, target: "/t/demo" },
    { label: "a safe path", next: "/t/acme", target: "/t/acme" },
    { label: "a safe path with query and hash", next: "/t/demo/tasks?view=board&page=2#top", target: "/t/demo/tasks?view=board&page=2#top" },
    { label: "dot segments normalised in-origin", next: "/t/demo/./a/../b", target: "/t/demo/b" },
    { label: "empty → /", next: "", target: "/" },
    { label: "an absolute URL → /", next: "https://evil.example/x", target: "/" },
    { label: "protocol-relative → /", next: "//evil.example/x", target: "/" },
    { label: "a relative path → /", next: "t/demo", target: "/" },
    { label: "a javascript: URL → /", next: "javascript:alert(1)", target: "/" },
    { label: "a backslash escape → /", next: "/\\evil.example", target: "/" },
    { label: "a backslash-slash escape → /", next: "/\\/evil.example", target: "/" },
    { label: "a tab-smuggled escape → /", next: "/\t/evil.example", target: "/" },
    { label: "a newline-smuggled escape → /", next: "/\n/evil.example", target: "/" },
    { label: "a dot-segment collapse to // → /", next: "/..//evil.example", target: "/" },
    { label: "a nested dot-segment collapse to // → /", next: "/t/..//evil.example", target: "/" },
  ];

  describe.each(HOSTS)("Host $host", ({ host, origin }) => {
    it.each(NEXT)("admitted next stays on validated Host: $label", async ({ next, target }) => {
      enabled();
      const res = await GET(local({ host, params: next === undefined ? {} : { next } }));
      expectAdmitted(res, { origin, target });
    });
  });

  it("a contradictory forwarded origin yields neither a cookie nor a redirect, even with a safe next", async () => {
    enabled();
    await expectRefusal(
      await GET(local({ params: { next: "/t/demo" }, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } }))
    );
  });
});

// ── AC06 — the admitted outcome ─────────────────────────────────────────────────────────────────

describe("GET /auth/dev-login — admitted outcome (AC06)", () => {
  it("deliberate local login signs the selected identity: the default email when none is given", async () => {
    enabled();
    expectAdmitted(await GET(local()), { origin: "http://localhost:3000", email: DEFAULT_EMAIL });
  });

  it("deliberate local login signs the selected identity: an empty email selects the default", async () => {
    enabled();
    expectAdmitted(await GET(local({ params: { email: "" } })), { origin: "http://localhost:3000", email: DEFAULT_EMAIL });
  });

  it("deliberate local login signs the selected identity: an explicit email is passed unchanged", async () => {
    enabled();
    const email = "Mixed.Case+tag@Example.TEST";
    expectAdmitted(await GET(local({ params: { email } })), { origin: "http://localhost:3000", email });
  });

  it("sets exactly one host-only session cookie with the existing options", async () => {
    enabled();
    const before = Date.now();
    const res = await GET(local());
    expect(res.status).toBe(307);
    const cookies = res.headers.getSetCookie().map(parseSetCookie);
    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    expect(cookie.name).toBe(SESSION_COOKIE);
    expect(cookie.value).toBe(TOKEN);
    expect(cookie.attributes.httponly).toBe(true);
    expect(String(cookie.attributes.samesite).toLowerCase()).toBe("lax");
    expect(cookie.attributes.path).toBe("/");
    expect(cookie.attributes["max-age"]).toBe(String(SESSION_MAX_AGE_S));
    // Host-only: no Domain. Nonproduction: not Secure.
    expect("domain" in cookie.attributes).toBe(false);
    expect("secure" in cookie.attributes).toBe(false);
    if ("expires" in cookie.attributes) {
      const expires = Date.parse(String(cookie.attributes.expires));
      expect(Math.abs(expires - (before + SESSION_MAX_AGE_S * 1000))).toBeLessThan(60_000);
    }
  });

  it("an admitted success is explicitly no-store", async () => {
    enabled();
    const res = await GET(local());
    expect(res.status).toBe(307);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ── AC07 — refusal and failure side effects ─────────────────────────────────────────────────────

describe("GET /auth/dev-login — refusal and failure side effects (AC07)", () => {
  it("refusals never echo the email, Host or forwarded values into the body or the logs", async () => {
    enabled();
    const marker = "leak-marker-7f3a91";
    const sinks = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    await expectRefusal(
      await GET(
        visible(`${LOCAL_URL}${query({ email: `${marker}@example.test`, next: `/${marker}` })}`, {
          host: `${marker}.example:3000`,
          "x-forwarded-host": `${marker}.example`,
          "x-forwarded-proto": "http",
        })
      )
    );
    const logged = sinks
      .flatMap((sink) => sink.mock.calls)
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n");
    expect(logged).not.toContain(marker);
  });

  it("admitted ensure/link/sign failures never return a successful cookie: ensureAuthUser fails", async () => {
    enabled();
    const failure = new Error("synthetic ensureAuthUser failure");
    auth.ensureAuthUser.mockRejectedValue(failure);
    await expect(GET(local())).rejects.toBe(failure);
    expect(auth.ensureAuthUser).toHaveBeenCalledTimes(1);
    expect(auth.linkMemberByEmail).toHaveBeenCalledTimes(0);
    expect(auth.signSession).toHaveBeenCalledTimes(0);
  });

  it("admitted ensure/link/sign failures never return a successful cookie: linkMemberByEmail fails", async () => {
    enabled();
    const failure = new Error("synthetic linkMemberByEmail failure");
    auth.linkMemberByEmail.mockRejectedValue(failure);
    await expect(GET(local())).rejects.toBe(failure);
    // The error propagates as-is: no retry of the earlier write, no signing after the failure.
    expect(auth.ensureAuthUser).toHaveBeenCalledTimes(1);
    expect(auth.linkMemberByEmail).toHaveBeenCalledTimes(1);
    expect(auth.signSession).toHaveBeenCalledTimes(0);
  });

  it("admitted ensure/link/sign failures never return a successful cookie: signSession fails", async () => {
    enabled();
    const failure = new Error("synthetic signSession failure");
    auth.signSession.mockRejectedValue(failure);
    await expect(GET(local())).rejects.toBe(failure);
    // Earlier admitted writes are neither replayed nor compensated: no rollback is promised.
    expect(auth.ensureAuthUser).toHaveBeenCalledTimes(1);
    expect(auth.linkMemberByEmail).toHaveBeenCalledTimes(1);
    expect(auth.signSession).toHaveBeenCalledTimes(1);
  });
});
