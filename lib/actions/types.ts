import type { DbClient } from "@/lib/db/types";
import type { Principal } from "@/lib/policy/evaluate";

/**
 * Action-layer contracts (Organ 4). An action is a policy-governed operation a principal
 * (typically an agent acting on behalf of a member) asks the brain to perform. Handlers
 * execute authorized actions; the SandboxRunner is the seam where untrusted code runs in
 * an isolated environment (E2B / microsandbox) — see docs/ARCHITECTURE.md.
 */

export interface ActionRequest {
  type: string; // e.g. "note.create", "code.run"
  resource: string; // policy match target, e.g. "project:acme/*"
  params: Record<string, unknown>;
}

export interface ActionContext {
  db: DbClient; // service-role client
  teamId: string;
  memberId: string | null;
  apiKeyId: string | null;
  principal: Principal;
  sandbox: SandboxRunner;
}

export interface ActionResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

export interface ActionHandler {
  /** Stable id matched against the request type and against policy `action`. */
  type: string;
  execute(ctx: ActionContext, params: Record<string, unknown>): Promise<ActionResult>;
}

/** Isolated code execution boundary (E2B / microsandbox adapter). */
export interface SandboxRunner {
  configured: boolean;
  run(input: { language: string; code: string; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/** Default runner: no sandbox wired. `code.run` fails closed until one is configured. */
export const unconfiguredSandbox: SandboxRunner = {
  configured: false,
  async run() {
    throw new Error("no sandbox configured (wire an E2B/microsandbox SandboxRunner)");
  },
};
