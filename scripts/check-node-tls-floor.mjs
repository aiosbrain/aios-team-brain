#!/usr/bin/env node
// Refuse to continue on a Node that predates the eMudhra trust-store fix (2026-10-20).
//
// Workflows that hold a credential run this right after `actions/setup-node`: the runner image's
// preinstalled Node can lag the fix (ubuntu-24.04 image 20261012 ships 22.23.3), and a Node that
// still trusts the compromised intermediates can be man-in-the-middled with any key it sends.
// Dependency-free (node builtins via scripts/doctor.mjs), so it runs before any `npm ci`.
import { checkNode, FAIL } from "./doctor.mjs";

const result = checkNode();
console.log(`node TLS floor: ${result.detail}`);
if (result.status === FAIL) {
  console.error(`::error title=Node predates the eMudhra trust-store fix::${result.detail}; ${result.fix}`);
  process.exit(1);
}
