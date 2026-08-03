#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { RAILWAY_TEMPLATE_URL } from "./setup/railway-template.mjs";

console.log(`AIOS Team Brain — Railway deploy\n\n${RAILWAY_TEMPLATE_URL}\n`);

const command = process.platform === "darwin" ? ["open", [RAILWAY_TEMPLATE_URL]]
  : process.platform === "win32" ? ["cmd", ["/c", "start", "", RAILWAY_TEMPLATE_URL]]
    : ["xdg-open", [RAILWAY_TEMPLATE_URL]];
const result = spawnSync(command[0], command[1], { stdio: "ignore" });
if ((result.status ?? 1) !== 0) {
  console.log("Could not open a browser automatically — copy the URL above.");
}
