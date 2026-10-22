// The patched-Node floor for the eMudhra CA compromise, in a module that imports nothing outside
// Node's built-ins. scripts/check-node-tls-floor.mjs runs it in workflows that never `npm ci`
// (they hold a credential and deliberately run no installed code), so it must never grow a
// dependency; test/guards/node-tls-floor-workflows.test.ts runs it with no node_modules to prove it.
// scripts/doctor.mjs re-exports both names.

const OK = "ok";
const FAIL = "fail";

// First release on each supported line whose built-in root store rejects the eMudhra intermediates
// with recoverable private keys (disclosed 2026-10-20). Node verifies TLS against this compiled-in
// store, so an older patch on a supported major is as exposed as an EOL one. The Dockerfile and
// install.sh carry the same table; test/doctor.test.ts fails if they drift.
export const NODE_TLS_FLOORS = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export function checkNode(version = process.versions.node) {
  const v = String(version).replace(/^v/, "");
  const major = Number.parseInt(v.split(".")[0], 10);
  if (!Number.isFinite(major)) return { status: FAIL, detail: `unrecognized node version ${version}` };
  const floor = NODE_TLS_FLOORS[major];
  const supported = Object.values(NODE_TLS_FLOORS).join(" / ");
  if (!floor) {
    return {
      status: FAIL,
      detail: `node ${v} — unsupported major (supported: ${supported})`,
      fix: `install Node ${NODE_TLS_FLOORS[22]} or newer on a supported line`,
    };
  }
  return cmpVersion(v, floor) >= 0
    ? { status: OK, detail: `node ${v}` }
    : {
        status: FAIL,
        detail: `node ${v} predates the eMudhra trust-store fix (need >=${floor})`,
        fix: `upgrade to Node ${floor} or newer`,
      };
}
