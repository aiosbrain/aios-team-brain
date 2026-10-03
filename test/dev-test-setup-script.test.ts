import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Spec (AIO-1210 AC09, docs/design/aio1210-dev-login.md): `scripts/dev-test-setup.sh` prints the local
// dev-login link. That link must always name the literal 127.0.0.1 and the explicitly configured
// local port (DEV_LOGIN_PORT, default 3000, canonical 1–65535), must never be derived from APP_URL,
// and must always come with the coupled launch (`npm run dev:login`) as its prerequisite — a server
// that merely answers is not a server with the bypass enabled. The script never requests the
// session-minting route to find out.
//
// The REAL script runs, copied into a disposable fake repository outside this checkout, so its own
// `cd "$BRAIN_DIR"` lands in the copy: the `.env.local` it sources is a harmless stub written there,
// `npm` / `npx` / `curl` are PATH stubs that only record how they were called, and the spoke builder
// is a fake. Nothing here resets or seeds a database, contacts a provider, or opens a socket.

const SCRIPT = join(process.cwd(), "scripts", "dev-test-setup.sh");
const APP_URL_MARKER = "https://app-url-marker.invalid:8443";

interface Fixture {
  root: string;
  repo: string;
  ops: string;
  bin: string;
  log: string;
}

interface Call {
  tool: string;
  cwd: string;
  args: string;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An executable that appends `<name>\t<cwd>\t<args>` to $STUB_LOG, then runs `extra`. */
function stub(path: string, name: string, extra = ""): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' ${name} "$PWD" "$*" >> "$STUB_LOG"\n${extra}`);
  chmodSync(path, 0o755);
}

function fixture(envLocal = "AIOS_DEV_LOGIN=0\n"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aio1210-dev-test-setup-"));
  roots.push(root);
  // Disposable, and never inside the task checkout.
  expect(realpathSync(root).startsWith(realpathSync(process.cwd()) + sep)).toBe(false);

  const repo = join(root, "repo");
  const ops = join(root, "ops");
  const bin = join(root, "bin");
  for (const dir of [join(repo, "scripts"), join(ops, "scripts"), bin]) mkdirSync(dir, { recursive: true });
  copyFileSync(SCRIPT, join(repo, "scripts", "dev-test-setup.sh"));
  writeFileSync(join(repo, ".env.local"), envLocal);

  stub(join(bin, "npm"), "npm");
  // The seed's only effect the script reads back: the demo key file, in the repository it ran in.
  stub(join(bin, "npx"), "npx", "printf 'fixture-demo-key\\n' > .aios-demo-key\necho '8 tasks materialized'\n");
  stub(join(bin, "curl"), "curl", 'exit "${STUB_CURL_EXIT:-0}"\n');
  stub(join(ops, "scripts", "demo-spoke.sh"), "spoke");
  return { root, repo, ops, bin, log: join(root, "calls.log") };
}

function run(fx: Fixture, env: Record<string, string> = {}, args: string[] = []) {
  const result = spawnSync("bash", [join(fx.repo, "scripts", "dev-test-setup.sh"), ...args], {
    // Stubs first; the rest is only what the script's own coreutils need. Nothing ambient is inherited.
    env: {
      PATH: `${fx.bin}:/usr/bin:/bin`,
      HOME: fx.root,
      OPS_DIR: fx.ops,
      SPOKE: join(fx.root, "spoke"),
      STUB_LOG: fx.log,
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls: Call[] = existsSync(fx.log)
    ? readFileSync(fx.log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [tool, cwd, ...rest] = line.split("\t");
          return { tool, cwd, args: rest.join("\t") };
        })
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

/** Every dev-login URL the script printed, parsed — the ACTUAL host and port, not a substring. */
function loginUrls(stdout: string): URL[] {
  return (stdout.match(/\S+\/auth\/dev-login\S*/g) ?? []).map((text) => new URL(text));
}

describe("scripts/dev-test-setup.sh — local dev-login link (AC09)", () => {
  it("prints one login link on the literal loopback address and the default port, with the coupled launch", () => {
    const fx = fixture();
    const { status, stdout } = run(fx);
    expect(status).toBe(0);

    const urls = loginUrls(stdout);
    expect(urls).toHaveLength(1);
    const [url] = urls;
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("3000");
    expect(url.pathname).toBe("/auth/dev-login");
    expect(Object.fromEntries(url.searchParams)).toEqual({ email: "alex@demo.aios.local", next: "/t/demo" });

    expect(stdout).toContain("start ONE dev server:   npm run dev:login\n");
    expect(stdout).not.toContain("--port");
  });

  it.each(["1", "4321", "65535"])("DEV_LOGIN_PORT=%s moves the link and names the matching launch", (port) => {
    const fx = fixture();
    const { status, stdout } = run(fx, { DEV_LOGIN_PORT: port });
    expect(status).toBe(0);
    const urls = loginUrls(stdout);
    expect(urls).toHaveLength(1);
    expect(urls[0].hostname).toBe("127.0.0.1");
    expect(urls[0].port).toBe(port);
    expect(stdout).toContain(`start ONE dev server:   npm run dev:login -- --port ${port}\n`);
  });

  it("an empty DEV_LOGIN_PORT is the default 3000", () => {
    const { status, stdout } = run(fixture(), { DEV_LOGIN_PORT: "" });
    expect(status).toBe(0);
    expect(loginUrls(stdout).map((url) => url.port)).toEqual(["3000"]);
  });

  it.each([
    ["zero", "0"],
    ["a leading zero", "03000"],
    ["65536", "65536"],
    ["a five-digit value above the range", "99999"],
    ["six digits", "100000"],
    ["a plus sign", "+3000"],
    ["a minus sign", "-1"],
    ["an exponent", "3e3"],
    ["hex", "0x10"],
    ["a decimal point", "3000.0"],
    ["letters", "abc"],
    ["a leading space", " 3000"],
    ["a trailing space", "3000 "],
    ["a trailing newline", "3000\n"],
    ["a host smuggled in front", "evil.example:3000"],
    ["a path smuggled behind", "3000/x"],
  ])("a non-canonical DEV_LOGIN_PORT (%s) is refused before anything runs", (_name, port) => {
    const { status, stdout, calls } = run(fixture(), { DEV_LOGIN_PORT: port });
    expect(status).toBe(1);
    expect(stdout).toContain("DEV_LOGIN_PORT must be a port number 1-65535");
    expect(loginUrls(stdout)).toEqual([]);
    // Refused before the reset, the seed, the spoke and the availability check.
    expect(calls).toEqual([]);
  });

  it("the launch prerequisite is unconditional: named whether or not a server answers", () => {
    const up = run(fixture(), { STUB_CURL_EXIT: "0" });
    const down = run(fixture(), { STUB_CURL_EXIT: "7" });
    for (const { status, stdout } of [up, down]) {
      expect(status).toBe(0);
      // A server that answers is not a server with the bypass on: the prerequisite is printed anyway.
      expect(stdout).toContain("start ONE dev server:   npm run dev:login\n");
      expect(stdout).toContain("under plain 'npm run dev' this link is a 404");
      expect(loginUrls(stdout)).toHaveLength(1);
    }
    expect(up.stdout).not.toContain("no server detected");
    expect(down.stdout).toContain("no server detected on http://127.0.0.1:3000 — run 'npm run dev:login' before");
  });

  it.each([
    ["the caller's environment", "AIOS_DEV_LOGIN=0\n", { APP_URL: APP_URL_MARKER }],
    [".env.local", `AIOS_DEV_LOGIN=0\nAPP_URL=${APP_URL_MARKER}\n`, {}],
  ])("the login link never follows APP_URL from %s, while the spoke and the API check still do", (_name, envLocal, env) => {
    const { status, stdout, calls } = run(fixture(envLocal), env);
    expect(status).toBe(0);

    const urls = loginUrls(stdout);
    expect(urls).toHaveLength(1);
    expect(urls[0].origin).toBe("http://127.0.0.1:3000");

    // APP_URL keeps its own, separate purpose.
    const spoke = calls.filter((call) => call.tool === "spoke");
    expect(spoke).toHaveLength(1);
    expect(spoke[0].args).toContain(`--brain-url ${APP_URL_MARKER} `);
    const curl = calls.filter((call) => call.tool === "curl");
    expect(curl).toHaveLength(1);
    expect(curl[0].args.endsWith(` ${APP_URL_MARKER}/api/v1/items`)).toBe(true);
  });

  it("never requests the session-minting route: the only probe is the API availability check", () => {
    const { status, calls } = run(fixture());
    expect(status).toBe(0);
    for (const call of calls) expect(call.args).not.toContain("dev-login");
    const curl = calls.filter((call) => call.tool === "curl");
    expect(curl).toHaveLength(1);
    expect(curl[0].args.endsWith(" http://127.0.0.1:3000/api/v1/items")).toBe(true);
  });

  it("runs entirely inside the disposable copy: stubbed reset and seed, fake spoke, no real tool", () => {
    const fx = fixture();
    const { status, calls } = run(fx);
    expect(status).toBe(0);

    expect(calls.map((call) => call.tool)).toEqual(["npm", "npx", "spoke", "curl"]);
    for (const call of calls) expect(realpathSync(call.cwd)).toBe(realpathSync(fx.repo));
    expect(calls[0].args).toBe("run db:test:up");
    expect(calls[1].args).toContain("scripts/seed-demo.ts");
    // The key the fake spoke was wired with is the one the stubbed seed wrote into the copy.
    expect(readFileSync(join(fx.repo, ".aios-demo-key"), "utf8").trim()).toBe("fixture-demo-key");
    expect(calls[2].args).toContain("--api-key fixture-demo-key ");
  });
});
