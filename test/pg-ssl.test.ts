import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ConnectionParameters from "pg/lib/connection-parameters.js";
import { parseCaCert, parseVerifyHostname, pgConnectionConfig, resolvePgTls } from "@/lib/db/pg/ssl.mjs";

/**
 * Spec for the shared Postgres TLS helper (lib/db/pg/ssl.mjs). Derived from what the deployment
 * needs, not from the implementation:
 *   - PG_CA_CERT set   → the server MUST be authenticated against that CA (verify-ca), and the
 *                        hostname is skipped because Railway's leaf is issued for `localhost`.
 *   - PG_TLS_VERIFY_HOSTNAME=1 → Node's default hostname check is kept (verify-full).
 *   - PG_CA_CERT unset → each call site's pre-existing behaviour, unchanged (one-click installs).
 *   - anything malformed → refuse, never a quiet downgrade to unverified.
 */

let dir: string;
let caPem: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pg-ssl-unit-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=root-ca", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.pem"),
  ], { stdio: "ignore" });
  caPem = readFileSync(path.join(dir, "ca.pem"), "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REMOTE = "postgres://u:p@postgres.railway.internal:5432/railway";

describe("parseCaCert — accepted encodings", () => {
  it("accepts a PEM verbatim", () => {
    expect(parseCaCert(caPem)).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("accepts base64 of the PEM (single-line env var)", () => {
    const b64 = Buffer.from(caPem).toString("base64");
    expect(parseCaCert(b64).trim()).toBe(caPem.trim());
  });

  it("accepts a PEM with literal \\n escapes and CRLF line endings", () => {
    expect(parseCaCert(caPem.replace(/\n/g, "\\n")).trim()).toBe(caPem.trim());
    expect(parseCaCert(caPem.replace(/\n/g, "\r\n")).trim()).toBe(caPem.trim());
  });
});

describe("parseCaCert — malformed input fails closed", () => {
  it.each([
    ["garbage", "not a certificate!"],
    ["base64 that is not a PEM", Buffer.from("hello world").toString("base64")],
    // Assembled at runtime so the secret scanner does not read a fixture as a committed key.
    ["a private key, not a certificate", `-----BEGIN ${"PRIVATE"} KEY-----\nAAAA\n-----END ${"PRIVATE"} KEY-----`],
    ["a truncated certificate body", "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkq\n-----END CERTIFICATE-----"],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseCaCert(raw)).toThrow(/PG_CA_CERT/);
  });

  it("resolvePgTls throws (does NOT fall back to unverified) on a malformed PG_CA_CERT", () => {
    expect(() => resolvePgTls(REMOTE, { legacyTls: true, env: { PG_CA_CERT: "junk!" } })).toThrow(/PG_CA_CERT/);
  });
});

describe("resolvePgTls — PG_CA_CERT set", () => {
  it("is verify-ca: pinned CA, rejectUnauthorized, hostname check disabled", () => {
    const r = resolvePgTls(REMOTE, { legacyTls: true, env: { PG_CA_CERT: caPem } });
    expect(r.mode).toBe("verify-ca");
    const ssl = r.ssl as { ca: string; rejectUnauthorized: boolean; checkServerIdentity: () => unknown };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain("BEGIN CERTIFICATE");
    expect(typeof ssl.checkServerIdentity).toBe("function");
    expect(ssl.checkServerIdentity()).toBeUndefined();
  });

  it("is verify-full with PG_TLS_VERIFY_HOSTNAME=1: Node's default hostname check is kept", () => {
    const r = resolvePgTls(REMOTE, { legacyTls: true, env: { PG_CA_CERT: caPem, PG_TLS_VERIFY_HOSTNAME: "1" } });
    expect(r.mode).toBe("verify-full");
    expect(r.ssl).toMatchObject({ rejectUnauthorized: true });
    expect((r.ssl as Record<string, unknown>).checkServerIdentity).toBeUndefined();
  });

  it("turns TLS ON for a remote URL even where the call site never asked for it", () => {
    // Production today: postgres.railway.internal, no sslmode, no PGSSL → plaintext. Pinning must
    // be enough on its own to get an authenticated connection.
    const r = resolvePgTls(REMOTE, { legacyTls: false, env: { PG_CA_CERT: caPem } });
    expect(r.mode).toBe("verify-ca");
    expect(r.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it("leaves a loopback/unix-socket connection that never wanted TLS in plaintext", () => {
    for (const url of ["postgres://a:b@localhost:5434/app_test", "postgres://a:b@127.0.0.1/x", "/var/run/postgresql"]) {
      expect(resolvePgTls(url, { legacyTls: false, env: { PG_CA_CERT: caPem } }).ssl).toBeUndefined();
    }
  });

  it("refuses a pinned CA combined with sslmode=disable", () => {
    expect(() =>
      resolvePgTls(`${REMOTE}?sslmode=disable`, { legacyTls: false, env: { PG_CA_CERT: caPem } })
    ).toThrow(/disables TLS/);
  });

  it("strips URL ssl params so node-postgres cannot replace the pinned ssl object", () => {
    const url = `${REMOTE}?sslmode=require&application_name=brain`;
    const cfg = pgConnectionConfig(url, { legacyTls: true, env: { PG_CA_CERT: caPem } });
    expect(cfg.connectionString).toBe(`${REMOTE}?application_name=brain`);
    // The property that matters: what pg ACTUALLY uses after merging the parsed URL over config.
    const effective = new ConnectionParameters(cfg).ssl as { ca?: string; rejectUnauthorized?: boolean };
    expect(effective.ca).toContain("BEGIN CERTIFICATE");
    expect(effective.rejectUnauthorized).toBe(true);
  });

  it.each([
    [`${REMOTE}?sslmode=no-verify&application_name=a@b`],
    [`${REMOTE}?ssl=no-verify&x=a@b`],
    [`${REMOTE}?sslmode=no-verify#x@y`],
    [`${REMOTE}?sslmode=require&sslmode=no-verify`],
    [`${REMOTE}?uselibpqcompat=true&sslmode=require`],
  ])("a pinned CA is what node-postgres actually uses for %s (no downgrade via URL params)", (url) => {
    const cfg = pgConnectionConfig(url, { legacyTls: true, env: { PG_CA_CERT: caPem } });
    const effective = new ConnectionParameters(cfg).ssl as { ca?: string; rejectUnauthorized?: boolean };
    expect(effective.rejectUnauthorized).toBe(true);
    expect(effective.ca).toContain("BEGIN CERTIFICATE");
  });

  it("refuses URL params that would REPLACE the pinned object (sslnegotiation=direct)", () => {
    expect(() =>
      resolvePgTls(`${REMOTE}?sslnegotiation=direct`, { legacyTls: true, env: { PG_CA_CERT: caPem } })
    ).toThrow(/replace the pinned TLS/);
  });

  it("an explicit sslmode=verify-full in the URL keeps the hostname check when pinning", () => {
    const r = resolvePgTls(`${REMOTE}?sslmode=verify-full`, { legacyTls: true, env: { PG_CA_CERT: caPem } });
    expect(r.mode).toBe("verify-full");
    expect((r.ssl as Record<string, unknown>).checkServerIdentity).toBeUndefined();
  });

  it("only loopback LITERALS are exempt: a DNS name starting 127. and an empty host with a remote PGHOST get TLS", () => {
    const env = { PG_CA_CERT: caPem };
    expect(resolvePgTls("postgres://a:b@127.0.0.1.nip.io/x", { legacyTls: false, env }).mode).toBe("verify-ca");
    expect(resolvePgTls("postgres://a:b@/x", { legacyTls: false, env: { ...env, PGHOST: "db.example.com" } }).mode).toBe(
      "verify-ca"
    );
    expect(resolvePgTls("postgres://a:b@/x", { legacyTls: false, env }).ssl).toBeUndefined(); // → localhost
  });

  it("PG_TLS_VERIFY_HOSTNAME=1 without PG_CA_CERT refuses (verification was asked for and cannot happen)", () => {
    expect(() => resolvePgTls(REMOTE, { legacyTls: true, env: { PG_TLS_VERIFY_HOSTNAME: "1" } })).toThrow(/needs PG_CA_CERT/);
  });

  it("rejects an unknown PG_TLS_VERIFY_HOSTNAME instead of guessing", () => {
    expect(() => parseVerifyHostname("yes-please")).toThrow(/PG_TLS_VERIFY_HOSTNAME/);
    expect(parseVerifyHostname(undefined)).toBe(false);
    expect(parseVerifyHostname("0")).toBe(false);
    expect(parseVerifyHostname("true")).toBe(true);
  });
});

describe("resolvePgTls — PG_CA_CERT unset keeps each call site's behaviour", () => {
  it("legacy TLS → { rejectUnauthorized: false }, reported as unverified", () => {
    const r = resolvePgTls(REMOTE, { legacyTls: true, env: {} });
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
    expect(r.connectionString).toBe(REMOTE);
    expect(r.mode).toBe("unverified");
  });

  it("no legacy TLS → the call site's own off value (undefined, or false for the backfill script)", () => {
    expect(resolvePgTls(REMOTE, { legacyTls: false, env: {} }).ssl).toBeUndefined();
    expect(resolvePgTls(REMOTE, { legacyTls: false, legacySslOff: false, env: {} }).ssl).toBe(false);
    expect(resolvePgTls(REMOTE, { legacyTls: false, env: {} }).mode).toBe("disabled");
  });

  it("leaves the connection string untouched", () => {
    const url = `${REMOTE}?sslmode=require`;
    expect(pgConnectionConfig(url, { legacyTls: true, env: {} }).connectionString).toBe(url);
  });

  it.each([
    [`${REMOTE}?sslmode=require`, true],
    [`${REMOTE}?sslmode=no-verify`, true],
    [`${REMOTE}?sslmode=disable`, true],
    [`${REMOTE}?ssl=true`, false],
    [`${REMOTE}?uselibpqcompat=true&sslmode=require`, true],
    [`${REMOTE}?sslmode=require&sslmode=no-verify`, true],
    [REMOTE, true],
    [REMOTE, false],
  ])("reports the mode node-postgres actually applies for %s (legacyTls=%s)", (url, legacyTls) => {
    const r = resolvePgTls(url, { legacyTls, env: {} });
    const eff = new ConnectionParameters({ connectionString: r.connectionString, ssl: r.ssl }).ssl as
      | boolean
      | { rejectUnauthorized?: boolean; ca?: string; checkServerIdentity?: unknown };
    const actual = !eff ? "disabled" : eff === true || eff.rejectUnauthorized !== false ? "verify-full" : "unverified";
    expect(r.mode).toBe(actual);
  });
});
