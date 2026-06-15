import { afterEach, describe, expect, it, vi } from "vitest";
import { createE2BSandbox } from "@/lib/actions/sandbox/e2b";

type Exec = { logs?: { stdout?: string[]; stderr?: string[] }; error?: { traceback?: string } };

function loaderFor(exec: Exec, kill = vi.fn()) {
  return async () => ({
    Sandbox: {
      create: async () => ({
        runCode: async (_code: string, _opts?: { language?: string }) => exec,
        kill,
      }),
    },
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("createE2BSandbox", () => {
  it("is unconfigured without an API key", () => {
    vi.stubEnv("E2B_API_KEY", "");
    expect(createE2BSandbox().configured).toBe(false);
  });

  it("is configured when an API key is provided", () => {
    expect(createE2BSandbox({ apiKey: "e2b_x" }).configured).toBe(true);
  });

  it("maps a successful execution to exit 0 with stdout/stderr", async () => {
    const kill = vi.fn();
    const sbx = createE2BSandbox({
      apiKey: "e2b_x",
      loader: loaderFor({ logs: { stdout: ["hello"], stderr: [] } }, kill),
    });
    const r = await sbx.run({ language: "python", code: "print('hello')" });
    expect(r).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("maps an execution error to exit 1 and appends the traceback", async () => {
    const sbx = createE2BSandbox({
      apiKey: "e2b_x",
      loader: loaderFor({ logs: { stderr: ["boom"] }, error: { traceback: "Traceback: x" } }),
    });
    const r = await sbx.run({ language: "python", code: "1/0" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("boom");
    expect(r.stderr).toContain("Traceback: x");
  });

  it("throws on run when no API key is set", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const sbx = createE2BSandbox({ loader: loaderFor({ logs: {} }) });
    await expect(sbx.run({ language: "python", code: "print(1)" })).rejects.toThrow(/E2B_API_KEY/);
  });
});
