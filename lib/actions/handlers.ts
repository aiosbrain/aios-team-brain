import "server-only";
import { createHash } from "node:crypto";
import { ingestItem } from "@/lib/ingest";
import { normalizeTier } from "@/lib/api/schemas";
import type { ActionContext, ActionHandler, ActionResult } from "./types";

/**
 * Built-in action handlers. Internal mutations route through the same audited write path
 * as sync (`lib/ingest`), preserving the single-write-path invariant. `code.run` delegates
 * to the injected SandboxRunner so untrusted code never executes in-process.
 */

function str(params: Record<string, unknown>, key: string, fallback = ""): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

/** note.create — write a deliverable item into the brain (via the audited ingest path). */
const noteCreate: ActionHandler = {
  type: "note.create",
  async execute(ctx: ActionContext, params): Promise<ActionResult> {
    const project = str(params, "project");
    const path = str(params, "path");
    const body = str(params, "body");
    if (!project || !path || !body) {
      return { ok: false, error: "note.create requires project, path, body" };
    }
    const access = normalizeTier(str(params, "access", "team"));
    if (!access) return { ok: false, error: "invalid access tier" };

    const result = await ingestItem(
      ctx.db,
      { teamId: ctx.teamId, memberId: ctx.memberId ?? "", apiKeyId: ctx.apiKeyId ?? "" },
      {
        project,
        path,
        kind: "deliverable",
        content_sha256: createHash("sha256").update(body).digest("hex"),
        actor: ctx.principal.actor,
        access,
        frontmatter: { created_by_action: true },
        body,
      },
      access
    );
    return { ok: true, output: { item_id: result.id, status: result.status } };
  },
};

/** code.run — execute code in the isolated sandbox (fails closed if none configured). */
const codeRun: ActionHandler = {
  type: "code.run",
  async execute(ctx: ActionContext, params): Promise<ActionResult> {
    if (!ctx.sandbox.configured) {
      return { ok: false, error: "no sandbox configured" };
    }
    const language = str(params, "language", "python");
    const code = str(params, "code");
    if (!code) return { ok: false, error: "code.run requires code" };
    const out = await ctx.sandbox.run({ language, code });
    return {
      ok: out.exitCode === 0,
      output: { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr },
      error: out.exitCode === 0 ? undefined : `exit ${out.exitCode}`,
    };
  },
};

export const BUILTIN_HANDLERS: ActionHandler[] = [noteCreate, codeRun];

export function handlerRegistry(handlers: ActionHandler[] = BUILTIN_HANDLERS): Map<string, ActionHandler> {
  return new Map(handlers.map((h) => [h.type, h]));
}
