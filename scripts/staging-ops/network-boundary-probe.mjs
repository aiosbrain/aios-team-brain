#!/usr/bin/env node
import { lookup } from "node:dns/promises";

const mode = process.argv[2];
const host = process.argv[3];
if (!host || !new Set(["allow", "deny"]).has(mode)) throw new Error("usage: network-boundary-probe.mjs allow|deny host");
try {
  const result = await lookup(host);
  if (mode === "deny") throw new Error(`forbidden host resolved to ${result.address}`);
  console.log(JSON.stringify({ status: "allowed-resolution", host }));
} catch (error) {
  if (mode === "allow") throw error;
  if (!new Set(["ENOTFOUND", "EAI_AGAIN"]).has(error?.code)) throw error;
  console.log(JSON.stringify({ status: "verified-dns-denial", host, code: error.code }));
}
