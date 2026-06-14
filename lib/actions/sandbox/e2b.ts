import "server-only";
import type { SandboxRunner } from "../types";

/**
 * E2B SandboxRunner — runs `code.run` actions in an isolated Firecracker microVM.
 *
 * Opt-in: the SDK is NOT a declared dependency (keeps the brain lean and avoids requiring
 * an E2B account). Enable with `npm i @e2b/code-interpreter` and set `E2B_API_KEY`; without
 * the key the runner reports `configured: false` and `code.run` fails closed.
 *
 * For self-hosted / air-gapped deployments, write a sibling adapter against the same
 * SandboxRunner interface (e.g. microsandbox) and wire it in the actions route.
 */

// String-typed specifier so tsc treats the dynamic import as `any` and does not require
// the (optional) package to be installed to typecheck.
const E2B_MODULE: string = "@e2b/code-interpreter";

type E2BModule = {
  Sandbox: {
    create(opts: { apiKey: string; timeoutMs?: number }): Promise<E2BSandbox>;
  };
};

type E2BSandbox = {
  runCode(
    code: string,
    opts?: { language?: string }
  ): Promise<{ logs?: { stdout?: string[]; stderr?: string[] }; error?: { traceback?: string } }>;
  kill?(): Promise<unknown>;
};

export type E2BOptions = {
  apiKey?: string;
  timeoutMs?: number;
  /** Test seam: override the SDK loader. */
  loader?: () => Promise<E2BModule>;
};

async function defaultLoader(): Promise<E2BModule> {
  try {
    return (await import(E2B_MODULE)) as unknown as E2BModule;
  } catch {
    throw new Error("@e2b/code-interpreter is not installed (run: npm i @e2b/code-interpreter)");
  }
}

export function createE2BSandbox(opts: E2BOptions = {}): SandboxRunner {
  const apiKey = opts.apiKey ?? process.env.E2B_API_KEY;
  const load = opts.loader ?? defaultLoader;
  return {
    configured: Boolean(apiKey),
    async run({ language, code, timeoutMs }) {
      if (!apiKey) throw new Error("E2B_API_KEY not set");
      const mod = await load();
      const sbx = await mod.Sandbox.create({ apiKey, timeoutMs: timeoutMs ?? opts.timeoutMs ?? 30_000 });
      try {
        const exec = await sbx.runCode(code, { language });
        const stdout = (exec.logs?.stdout ?? []).join("");
        const stderr = (exec.logs?.stderr ?? []).join("");
        if (exec.error) {
          const tb = exec.error.traceback ? `\n${exec.error.traceback}` : "";
          return { exitCode: 1, stdout, stderr: stderr + tb };
        }
        return { exitCode: 0, stdout, stderr };
      } finally {
        await sbx.kill?.();
      }
    },
  };
}
