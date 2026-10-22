import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgConnectionConfig } from "@/lib/db/pg/ssl.mjs";

/**
 * The negative proof for verify-ca, at the wire. A fake Postgres speaks the real SSLRequest
 * preamble (int32 8, int32 80877103 → 'S'), upgrades to TLS with the SAME chain shape Railway's
 * Postgres presents (a leaf for some OTHER hostname, issued by a self-signed `CN=root-ca`, chain sent), and
 * — only if the handshake completes — answers the startup message with a FATAL "tls-handshake-ok".
 * So the error a real `pg.Client` surfaces tells us exactly how far it got:
 *   wrong CA   → certificate error, the server never sees a TLS session
 *   right CA   → "tls-handshake-ok", although the leaf names a different host than we dial
 *   verify-full→ hostname error on the same mismatch (the flag is not a no-op)
 * If the helper ever regressed to `rejectUnauthorized: false`, the wrong-CA case would read
 * "tls-handshake-ok" and this test would go red.
 */

let dir: string;
let server: net.Server;
let port: number;
let rightCa: string;
let wrongCa: string;
const secured: string[] = [];

function openssl(args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
}

function makeCa(name: string) {
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=root-ca",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout", `${name}.key`, "-out", `${name}.pem`]);
  return readFileSync(path.join(dir, `${name}.pem`), "utf8");
}

/** Postgres ErrorResponse: 'E', int32 length, fields, terminator. */
function errorResponse(message: string) {
  const body = Buffer.concat([
    Buffer.from("SFATAL\0"), Buffer.from("C28000\0"), Buffer.from(`M${message}\0`), Buffer.from([0]),
  ]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pg-tls-handshake-"));
  rightCa = makeCa("right-ca");
  wrongCa = makeCa("wrong-ca"); // same subject CN=root-ca — only the key differs, like staging vs prod
  writeFileSync(path.join(dir, "leaf.ext"), "subjectAltName=DNS:db.leaf.invalid\nbasicConstraints=CA:FALSE\n");
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=db.leaf.invalid", "-keyout", "leaf.key", "-out", "leaf.csr"]);
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "right-ca.pem", "-CAkey", "right-ca.key", "-CAcreateserial",
    "-days", "2", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const key = readFileSync(path.join(dir, "leaf.key"));
  const cert = readFileSync(path.join(dir, "leaf.pem"), "utf8") + rightCa;

  server = net.createServer((socket) => {
    socket.once("data", (buf) => {
      if (buf.length < 8 || buf.readInt32BE(0) !== 8 || buf.readInt32BE(4) !== 80877103) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
      secure.on("secure", () => secured.push("ok"));
      secure.on("error", () => {});
      secure.once("data", () => secure.end(errorResponse("tls-handshake-ok")));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

async function connectError(env: Record<string, string>): Promise<Error & { code?: string }> {
  // The leaf names db.leaf.invalid and we dial 127.0.0.1: a guaranteed hostname mismatch, the
  // condition Railway always has (leaf says localhost, we dial postgres.railway.internal). The
  // leaf is NOT for "localhost" here because node-postgres sets no TLS servername for an IP host, so
  // Node would check the default "localhost" — a localhost leaf would silently pass verify-full.
  const url = `postgres://u:p@127.0.0.1:${port}/db`;
  const client = new pg.Client({ ...pgConnectionConfig(url, { legacyTls: true, env }), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (err) {
    return err as Error & { code?: string };
  } finally {
    await client.end().catch(() => {});
  }
  throw new Error("fake server never lets a connection complete");
}

describe("verify-ca against a Postgres SSLRequest handshake", () => {
  it("REFUSES a server whose chain does not lead to the pinned CA", async () => {
    const before = secured.length;
    const err = await connectError({ PG_CA_CERT: wrongCa });
    expect(err.message).not.toMatch(/tls-handshake-ok/);
    expect(err.code ?? err.message).toMatch(/SELF_SIGNED_CERT_IN_CHAIN|CERT_SIGNATURE_FAILURE|UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
    expect(secured.length).toBe(before);
  });

  it("ACCEPTS the right CA even though the hostname does not match the leaf", async () => {
    const err = await connectError({ PG_CA_CERT: rightCa });
    expect(err.message).toBe("tls-handshake-ok");
  });

  it("accepts the right CA passed base64-encoded", async () => {
    const err = await connectError({ PG_CA_CERT: Buffer.from(rightCa).toString("base64") });
    expect(err.message).toBe("tls-handshake-ok");
  });

  it("verify-full (PG_TLS_VERIFY_HOSTNAME=1) rejects the same hostname mismatch", async () => {
    const err = await connectError({ PG_CA_CERT: rightCa, PG_TLS_VERIFY_HOSTNAME: "1" });
    expect(err.message).not.toMatch(/tls-handshake-ok/);
    expect(err.code ?? err.message).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|altnames|Hostname\/IP/i);
  });

  it("documents the gap being closed: with no PG_CA_CERT any server certificate is accepted", async () => {
    const err = await connectError({});
    expect(err.message).toBe("tls-handshake-ok");
  });
});
