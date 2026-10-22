#!/usr/bin/env node
/**
 * Copy the harness's command logs and receipts somewhere durable, WITHOUT copying its secrets.
 *
 * The harness root is a `mktemp -d` that the exit trap deletes, so every failure receipt and command
 * log died with it — including on CI, where that is the only record of why a required lane failed.
 * It also holds the generated harness keys, so "keep the directory" is not the fix.
 *
 * This copies `*.log` only, with three redactions applied to every line:
 *   1. every literal secret value found in the harness secrets directory (they are short, generated
 *      and high-entropy, so a substring match is exact and cheap);
 *   2. credentials embedded in URLs (`scheme://user:pass@host`), which is how a Postgres or Neo4j
 *      connection string leaks through a driver's error text;
 *   3. bearer/authorization tokens in echoed commands.
 *
 * Redaction is a backstop, not the plan: the receipts themselves carry identities only
 * (`receipts.mjs` refuses a credential-shaped field), and this exists because a log line is written
 * by whatever threw.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReceipts, RECEIPT_PREFIX } from "./receipts.mjs";

/** Every file under `dir`, read as text. Missing directory ⇒ no secrets to mask. */
function collectSecrets(dir) {
  const values = new Set();
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current); } catch { return; }
    for (const name of entries) {
      const full = join(current, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      const text = readFileSync(full, "utf8").trim();
      // A very short value would mask innocuous substrings everywhere; generated key material is long.
      if (text.length >= 8) values.add(text);
    }
  };
  walk(dir);
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactText(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted-harness-secret]");
  }
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]:[redacted]@");
  out = out.replace(/(authorization:\s*Bearer\s+)\S+/gi, "$1[redacted]");
  out = out.replace(/(-H\s+['"]?authorization:\s*Bearer\s+)[^'"\s]+/gi, "$1[redacted]");
  // The privileged staging health token travels in its OWN header, not in `Authorization`, so the
  // bearer rules never saw it. It became reachable when the harness started preserving Compose
  // SERVICE logs: those carry whatever a service wrote about an inbound request, and this token is
  // a compose literal rather than a file in the secrets directory, so the literal-value masking
  // above does not cover it either.
  out = out.replace(/(x-aios-staging-(?:health-token|boot-probe):\s*)\S+/gi, "$1[redacted]");
  return out;
}

export function preserveArtifacts({ harnessRoot, secretsDir, destination }) {
  mkdirSync(destination, { recursive: true });
  const secrets = collectSecrets(secretsDir);
  const receipts = [];
  let copied = 0;
  for (const name of readdirSync(harnessRoot)) {
    if (!name.endsWith(".log")) continue;
    const redacted = redactText(readFileSync(join(harnessRoot, name), "utf8"), secrets);
    writeFileSync(join(destination, name), redacted, { mode: 0o600 });
    copied += 1;
    for (const receipt of parseReceipts(redacted)) receipts.push({ log: name, ...receipt });
  }
  writeFileSync(join(destination, "receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
  return { copied, receipts: receipts.length, prefix: RECEIPT_PREFIX };
}

if (process.argv[1] && process.argv[1].endsWith("redact-artifacts.mjs")) {
  const [harnessRoot, secretsDir, destination] = process.argv.slice(2);
  if (!harnessRoot || !destination) {
    console.error("usage: redact-artifacts.mjs <harness-root> <secrets-dir> <destination>");
    process.exit(1);
  }
  console.log(JSON.stringify(preserveArtifacts({ harnessRoot, secretsDir, destination })));
}
