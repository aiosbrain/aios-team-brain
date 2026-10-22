import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isDirectEntry, verifyMainPolicyFromProvider } from "../scripts/staging-ops/verify-main-policy.mjs";
import { buildMainRulesets, REQUIRED_MAIN_CONTEXTS } from "../scripts/staging-ops/main-policy.mjs";

/**
 * M5/AC-03. `verifyEffectiveMainPolicy` was a pure evaluator whose only callers were tests, so the
 * criterion "an effective-policy verifier exists" was met by something nobody could point at
 * GitHub. These cover the acquisition half, fixture-backed.
 *
 * The two properties that matter most here are both about NOT claiming readiness:
 *  - applicability is MEASURED (`/rules/branches/main`), never inferred from whether a ruleset's ref
 *    pattern spells `refs/heads/main` — inherited org rulesets and wildcard targets apply to main
 *    and do not spell it, so inference silently drops live restrictions;
 *  - an unreadable ruleset, an unsupported source or an authorization failure is
 *    `measurement-incomplete`, which is a different outcome from a policy mismatch and from a pass.
 */

const NORMAL_APP = 111;
const EMERGENCY_APP = 222;
const PRODUCER = 999;
const REPOSITORY = "org/repo";

const producerIds = Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context) => [context, PRODUCER]));
const desired = buildMainRulesets({ normalAppId: NORMAL_APP, emergencyAppId: EMERGENCY_APP, producerIds });

const env = {
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_POLICY_READ_TOKEN: "policy-read-token",
  MAIN_POLICY_NORMAL_APP_ID: String(NORMAL_APP),
  MAIN_POLICY_EMERGENCY_APP_ID: String(EMERGENCY_APP),
  MAIN_POLICY_PRODUCER_IDS: JSON.stringify(producerIds),
} as unknown as NodeJS.ProcessEnv;

interface FixtureOptions {
  /** One applicable-rule entry per ruleset. `sourceType` drives which detail endpoint is expected. */
  rulesets?: { id: number; sourceType: string; detail: unknown | null; status?: number }[];
  classicStatus?: number;
  classicBody?: unknown;
  rulesStatus?: number;
}

function provider(options: FixtureOptions = {}) {
  const rulesets = options.rulesets ?? desired.map((ruleset, index) => ({ id: index + 1, sourceType: "Repository", detail: ruleset }));
  const requests: { url: string; method: string }[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, method: String(init.method ?? "GET") });
    if (url.includes("/rules/branches/main")) {
      if (options.rulesStatus) return new Response("{}", { status: options.rulesStatus });
      // Two rule entries per ruleset, so the de-duplication by ruleset id is exercised rather than
      // assumed, and page 2 is empty so pagination terminates through the real path.
      if (url.includes("page=1")) {
        return Response.json(rulesets.flatMap((r) => [0, 1].map(() => ({
          type: "stub", ruleset_id: r.id, ruleset_source_type: r.sourceType, ruleset_source: r.sourceType === "Organization" ? "org" : REPOSITORY,
        }))));
      }
      return Response.json([]);
    }
    const match = /\/(?:repos\/org\/repo|orgs\/org)\/rulesets\/(\d+)/.exec(url);
    if (match) {
      const found = rulesets.find((r) => r.id === Number(match[1]))!;
      if (found.status) return new Response("{}", { status: found.status });
      return Response.json(found.detail);
    }
    if (url.includes("/branches/main/protection")) {
      return new Response(JSON.stringify(options.classicBody ?? {}), { status: options.classicStatus ?? 404 });
    }
    throw new Error(`unhandled fixture request ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

describe("the effective main-policy verifier has an executable acquisition path", () => {
  it("passes only when the measured applicable policy equals the desired contract, using GETs only", async () => {
    const { fetchImpl, requests } = provider();
    const result = await verifyMainPolicyFromProvider(env, { fetchImpl });
    expect(result).toMatchObject({ ok: true, status: "policy-matches-contract", measured: true, rulesets: 3 });
    // READ-ONLY, asserted on the requests actually issued rather than on intent.
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    // Applicability came from the branch-rules endpoint, not from filtering a ruleset list.
    expect(requests.some((request) => request.url.includes("/rules/branches/main"))).toBe(true);
    // …and each ruleset was resolved once despite two applicable rule entries pointing at it.
    expect(requests.filter((request) => /\/rulesets\/\d+/.test(request.url)).length).toBe(3);
  });

  it("reads an INHERITED organization ruleset that no ref-pattern filter would have matched", async () => {
    // The applicability case the pure evaluator's `refs/heads/main` filter cannot see: an org
    // ruleset targeting the default branch. It must be fetched from the ORG endpoint and evaluated,
    // not dropped — dropping it would report a clean policy while it was enforcing on main.
    const inherited = {
      name: "org-wide-extra", target: "branch", enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: [{ actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" }],
      rules: [{ type: "required_signatures" }],
    };
    const { fetchImpl, requests } = provider({
      rulesets: [
        ...desired.map((ruleset, index) => ({ id: index + 1, sourceType: "Repository", detail: ruleset })),
        { id: 42, sourceType: "Organization", detail: inherited },
      ],
    });
    const result = await verifyMainPolicyFromProvider(env, { fetchImpl });
    expect(requests.some((request) => request.url.includes("/orgs/org/rulesets/42"))).toBe(true);
    // Evaluated, and its non-App bypass reported — an extra applicable restriction is not harmless
    // just because the three desired rulesets are correct.
    expect(result.ok).toBe(false);
    expect(result.status).toBe("policy-differs-from-contract");
    expect(result.errors.join("; ")).toMatch(/org-wide-extra has an unexpected non-App bypass/);
  });

  it("reports a MISMATCH when a desired ruleset is absent or altered", async () => {
    const missing = provider({ rulesets: desired.slice(0, 2).map((ruleset, index) => ({ id: index + 1, sourceType: "Repository", detail: ruleset })) });
    const absent = await verifyMainPolicyFromProvider(env, { fetchImpl: missing.fetchImpl });
    expect(absent).toMatchObject({ ok: false, status: "policy-differs-from-contract", measured: true });
    expect(absent.errors.join("; ")).toMatch(/missing active ruleset main-release-writer/);

    const weakened = structuredClone(desired);
    weakened[0].enforcement = "evaluate";
    const altered = provider({ rulesets: weakened.map((ruleset, index) => ({ id: index + 1, sourceType: "Repository", detail: ruleset })) });
    const result = await verifyMainPolicyFromProvider(env, { fetchImpl: altered.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.errors.join("; ")).toMatch(/main-integrity/);
  });

  it("distinguishes classic protection that is ABSENT from classic protection it could not read", async () => {
    // 404 is the one status that means "explicitly not configured".
    const absent = await verifyMainPolicyFromProvider(env, { fetchImpl: provider({ classicStatus: 404 }).fetchImpl });
    expect(absent).toMatchObject({ ok: true, measured: true });

    // 403 is an authorization gap. Reporting it as absent would turn a permission problem into a
    // passing check — the single most costly confusion this verifier can make.
    const unreadable = await verifyMainPolicyFromProvider(env, { fetchImpl: provider({ classicStatus: 403 }).fetchImpl });
    expect(unreadable).toMatchObject({ ok: false, status: "measurement-incomplete", measured: false });
    expect(unreadable.errors.join("; ")).toMatch(/could not be measured/);

    // A classic rule that IS configured conflicts with the App bypass matrix and is a mismatch,
    // not an incomplete measurement.
    const conflicting = await verifyMainPolicyFromProvider(env, {
      fetchImpl: provider({ classicStatus: 200, classicBody: { required_status_checks: { contexts: [] } } }).fetchImpl,
    });
    expect(conflicting).toMatchObject({ ok: false, status: "policy-differs-from-contract" });
    expect(conflicting.errors.join("; ")).toMatch(/classic required status checks conflict/);
  });

  it.each([
    ["the applicable-rules read fails", { rulesStatus: 403 }],
    ["an applicable ruleset cannot be read", { rulesets: [{ id: 1, sourceType: "Repository", detail: null, status: 403 }] }],
    ["an applicable ruleset has an unsupported source", { rulesets: [{ id: 1, sourceType: "Enterprise", detail: null }] }],
  ] as const)("refuses as INCOMPLETE, never as a pass, when %s", async (_label, options) => {
    const result = await verifyMainPolicyFromProvider(env, { fetchImpl: provider(options as FixtureOptions).fetchImpl });
    expect(result).toMatchObject({ ok: false, status: "measurement-incomplete", measured: false });
  });

  it("refuses before any request when the measured expectations are missing", async () => {
    const { fetchImpl, requests } = provider();
    await expect(verifyMainPolicyFromProvider({ ...env, MAIN_POLICY_PRODUCER_IDS: "{" } as NodeJS.ProcessEnv, { fetchImpl }))
      .rejects.toThrow(/MAIN_POLICY_PRODUCER_IDS/);
    await expect(verifyMainPolicyFromProvider({ ...env, GITHUB_POLICY_READ_TOKEN: "" } as NodeJS.ProcessEnv, { fetchImpl }))
      .rejects.toThrow(/GITHUB_POLICY_READ_TOKEN/);
    expect(requests).toEqual([]);
  });

  it("reports a mismatch when a producer integration differs from the measured expectation", async () => {
    // The actor half of the contract, not just the rule shapes: a check satisfied by the wrong
    // integration is the substitution AC-03 exists to refuse.
    const wrongProducer = structuredClone(desired);
    const statusRule = wrongProducer[1].rules[0] as { parameters: { required_status_checks: { integration_id: number }[] } };
    statusRule.parameters.required_status_checks[0].integration_id = PRODUCER + 1;
    const result = await verifyMainPolicyFromProvider(env, {
      fetchImpl: provider({ rulesets: wrongProducer.map((ruleset, index) => ({ id: index + 1, sourceType: "Repository", detail: ruleset })) }).fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("; ")).toMatch(/main-release-evidence rules differs/);
  });
});

/**
 * L8 — the verifier must actually RUN when it is invoked, and must stay silent when imported.
 *
 * The old direct-entry test compared `import.meta.url` against `file://${process.argv[1]}`: an
 * encoded URL against a raw path. From a symlinked path — or one containing a space — it matched
 * nothing, so the process printed nothing and exited **0**, which a shell and a workflow both read
 * as "the policy is correct". A verifier that cannot fail is exactly the false green AC-08 forbids.
 */
describe("the verifier's CLI fires on real invocation and only on real invocation", () => {
  const CLI = path.resolve("scripts/staging-ops/verify-main-policy.mjs");
  const run = promisify(execFile);
  const roots: string[] = [];
  afterAll(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  /** No config on purpose: the refusal is the observable, and it is the same one on both paths. */
  const invoke = async (entry: string) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "" } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  };

  it("exits NONZERO with the same refusal whether invoked directly or through a symlink", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "main-policy cli-"));
    roots.push(root);
    // A directory with a SPACE and a SYMLINK: the two shapes the old comparison silently missed,
    // together, in one entry path.
    const link = path.join(root, "verify-main-policy.mjs");
    symlinkSync(CLI, link);

    const direct = await invoke(CLI);
    const linked = await invoke(link);

    // Nonzero, not merely "different from a pass": exit 0 having printed nothing was the defect.
    expect(direct.code, `direct invocation exited 0: ${direct.stdout}`).not.toBe(0);
    expect(linked.code, `symlinked invocation exited 0: ${linked.stdout}`).not.toBe(0);
    // …and the SAME refusal, so the symlinked path is running the verifier rather than failing for
    // some incidental reason of its own.
    expect(direct.stderr).toMatch(/main policy verification refused: GITHUB_REPOSITORY/);
    expect(linked.stderr).toBe(direct.stderr);
  }, 30_000);

  it("stays silent when the module is merely IMPORTED", async () => {
    // The other half. This very file imports it, so a CLI that fired on import would have run
    // against the real GitHub API during the unit tier. Asserted on the predicate too, because an
    // importing entry point that happens to pass `--run` must not fire it either.
    const root = mkdtempSync(path.join(tmpdir(), "main-policy-import-"));
    roots.push(root);
    const importer = path.join(root, "importer.mjs");
    writeFileSync(importer, `import ${JSON.stringify(CLI)};\nconsole.log("imported cleanly");\n`);
    const imported = await invoke(importer);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("imported cleanly");
    expect(imported.stderr).toBe("");
  }, 30_000);

  it("discriminates: it is the resolved FILE, not an argv word", () => {
    expect(isDirectEntry(CLI)).toBe(true);
    expect(isDirectEntry(path.resolve("scripts/staging-ops/main-policy.mjs"))).toBe(false);
    // An entry-less process (`node -e`, a REPL) has no argv[1] at all.
    expect(isDirectEntry("")).toBe(false);
    // `--run` is not this module's convention; a sibling CLI using it must not fire this one.
    expect(isDirectEntry("--run")).toBe(false);
  });
});
