// Spec: the 2026-06-27 cross-project deploy incident must remain impossible, while provisioning a brand-new
// project is allowed. These assertions are written from that boundary, not from the code.
//
// The load-bearing test here is "the shipped guard agrees with the policy module": the guard is
// what actually blocks commands in Claude Code, the policy module is what setup.mjs restrains
// itself with, and a silent divergence between them would re-open the incident.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_VERBS,
  assertPinnedTarget,
  classifyRailwayCommand,
  isSanctionedProjectName,
  toProjectName,
} from "../scripts/railway-policy.mjs";

const GUARD = path.resolve(__dirname, "..", "scripts", "railway-deploy-guard.sh");

/** Run the real PreToolUse hook exactly as Claude Code does: JSON on stdin, exit 2 = blocked. */
function guardBlocks(command: string): boolean {
  const r = spawnSync("bash", [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });
  return r.status === 2;
}

const FORBIDDEN_COMMANDS = [
  "railway up",
  "railway up --detach",
  "railway redeploy",
  "railway down",
  "railway delete",
  // The exact shape of the incident: a drifted directory reached by cd.
  "cd ../other-worktree && railway up",
  "npm run build; railway redeploy",
  "railway up | tee log.txt",
];

const PROVISIONING_COMMANDS = [
  "railway init --name aios-acme",
  "railway add --database postgres",
  "railway variables --set PGSSL=require",
  "railway domain",
  "railway run -- npx tsx scripts/admin.ts create-team acme",
];

const READONLY_COMMANDS = ["railway status", "railway status --json", "railway logs", "railway whoami", "railway deployment list"];

describe("forbidden verbs — always, under any framing", () => {
  it.each(FORBIDDEN_COMMANDS)("policy blocks: %s", (cmd) => {
    expect(classifyRailwayCommand(cmd).decision).toBe("block");
  });

  it.each(FORBIDDEN_COMMANDS)("the shipped guard also blocks: %s", (cmd) => {
    expect(guardBlocks(cmd)).toBe(true);
  });

  it("covers every verb named in FORBIDDEN_VERBS, so adding one cannot be forgotten", () => {
    for (const verb of FORBIDDEN_VERBS) {
      expect(classifyRailwayCommand(`railway ${verb}`).decision).toBe("block");
      expect(guardBlocks(`railway ${verb}`)).toBe(true);
    }
  });
});

describe("provisioning verbs — allowed, because a new project has nothing to take down", () => {
  it.each(PROVISIONING_COMMANDS)("policy allows: %s", (cmd) => {
    expect(classifyRailwayCommand(cmd).decision).toBe("allow");
  });

  it.each(PROVISIONING_COMMANDS)("the shipped guard also allows: %s", (cmd) => {
    expect(guardBlocks(cmd)).toBe(false);
  });

  it("still blocks a forbidden verb chained after a provisioning one", () => {
    expect(classifyRailwayCommand("railway init --name aios-x && railway up").decision).toBe("block");
    expect(guardBlocks("railway init --name aios-x && railway up")).toBe(true);
  });
});

describe("read-only verbs", () => {
  it.each(READONLY_COMMANDS)("allowed: %s", (cmd) => {
    expect(classifyRailwayCommand(cmd).decision).toBe("allow");
    expect(guardBlocks(cmd)).toBe(false);
  });
});

describe("writing about the commands is not running them", () => {
  it("does not block prose or docs that merely mention a forbidden verb", () => {
    const prose = "The `railway up` verb is forbidden here; see the 2026-06-27 incident.";
    expect(classifyRailwayCommand(prose).decision).toBe("allow");
    expect(guardBlocks(prose)).toBe(false);
  });

  it("ignores non-railway commands entirely", () => {
    expect(classifyRailwayCommand("git push origin main").decision).toBe("allow");
    expect(classifyRailwayCommand("").decision).toBe("allow");
  });
});

describe("project naming — enforced at creation, not discovered at first deploy", () => {
  it("accepts what scripts/service-guard.mjs accepts", () => {
    expect(isSanctionedProjectName("aios")).toBe(true);
    expect(isSanctionedProjectName("aios-acme")).toBe(true);
  });

  it("rejects a name whose schema load the runtime guard would abort", () => {
    expect(isSanctionedProjectName("other-project")).toBe(false);
    expect(isSanctionedProjectName("acme-aios")).toBe(false);
    expect(isSanctionedProjectName("")).toBe(false);
  });

  it("normalizes a team slug into a sanctioned project name", () => {
    expect(toProjectName("acme")).toBe("aios-acme");
    expect(toProjectName("Acme Robotics")).toBe("aios-acme-robotics");
    expect(toProjectName("aios-acme")).toBe("aios-acme"); // already prefixed — not doubled
    expect(toProjectName("")).toBeNull();
  });
});

describe("assertPinnedTarget — the drift check that makes writes safe", () => {
  it("passes when the CLI points where this run provisioned", () => {
    expect(assertPinnedTarget({ name: "aios-acme" }, "aios-acme")).toBe(true);
  });

  it("throws on drift, naming both sides", () => {
    expect(() => assertPinnedTarget({ name: "other-project" }, "aios-acme")).toThrow(
      /other-project.*aios-acme|aios-acme.*other-project/s
    );
  });

  it("throws when the target is unknown rather than assuming it is fine", () => {
    expect(() => assertPinnedTarget(null, "aios-acme")).toThrow(/no project/i);
    expect(() => assertPinnedTarget({}, "aios-acme")).toThrow(/no project/i);
  });

  it("throws when the linked project is not an AIOS project at all", () => {
    expect(() => assertPinnedTarget({ name: "other-project" }, "other-project")).toThrow(/service-guard|AIOS project name/i);
  });
});

describe("STGENV-4 — the shell verb is forbidden, and both layers agree it is", () => {
  // It was added late and for a DIFFERENT reason than the four deploy verbs: it deploys nothing, it
  // opens a WRITE-CAPABLE SHELL inside a running container, where GRAPHITI_URL plus one request is
  // an unscoped whole-graph wipe against a sidecar with no auth. The pre-push review found the two
  // enforcement layers disagreeing — the settings deny list refused it while the hook classified it
  // `allow · read-only`, because it was in no verb list at all. Two layers that disagree is the
  // thing this file exists to prevent.
  const VERB = "s" + "sh"; // assembled so this test file is not itself blocked by the hook it tests

  it("the policy module classifies it forbidden", () => {
    expect(FORBIDDEN_VERBS).toContain(VERB);
    expect(classifyRailwayCommand(`railway ${VERB} -e staging`).decision).toBe("block");
  });

  it("the hook blocks it too — not merely the module", () => {
    expect(guardBlocks(`railway ${VERB} -e staging -s aios-team-brain`)).toBe(true);
    // ...and still blocks it when chained, the shape a classifier keyed on the first word misses.
    expect(guardBlocks(`cd /tmp && railway ${VERB}`)).toBe(true);
  });

  it("a read-only verb is still allowed, so this did not just ban the CLI", () => {
    expect(guardBlocks("railway status")).toBe(false);
  });
});
