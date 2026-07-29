// Spec: the provisioner may create a brand-new brain, and may never deploy or write to a
// project it did not create. Driven through a fake Railway CLI so the whole command sequence
// is observable — the assertions are about what it ACTUALLY runs, not what it documents.
import { describe, expect, it, vi } from "vitest";
import {
  buildVariables,
  finishSetup,
  generateSecrets,
  makeRailway,
  nextPhase,
  runSetup,
  toVariableArgs,
} from "../scripts/setup.mjs";
import { FORBIDDEN_VERBS } from "../scripts/railway-policy.mjs";

/** A fake Railway CLI that records every invocation and answers plausibly. */
function fakeRailway({ linkedTo = null }: { linkedTo?: string | null } = {}) {
  const calls: string[][] = [];
  let project = linkedTo;
  const exec = vi.fn((cmd: string, args: string[]) => {
    calls.push(args);
    const verb = args[0];
    if (verb === "whoami") return { status: 0, stdout: "you@example.com", stderr: "" };
    if (verb === "status") {
      return project
        ? { status: 0, stdout: JSON.stringify({ name: project }), stderr: "" }
        : { status: 0, stdout: "", stderr: "no linked project" };
    }
    if (verb === "init") {
      project = args[args.indexOf("--name") + 1];
      return { status: 0, stdout: `created ${project}`, stderr: "" };
    }
    if (verb === "domain") return { status: 0, stdout: "https://aios-acme.up.railway.app", stderr: "" };
    if (verb === "run") {
      return { status: 0, stdout: "✓ member you@acme.com\n✓ password set (copy now, shown once): s3cret-pw-x", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  return { exec, calls, log: vi.fn() };
}

const OPTS = { slug: "acme", displayName: "Acme Robotics", email: "you@acme.com", memberName: "You" };

describe("the provisioner never deploys", () => {
  it("emits no forbidden verb across a full provisioning run", async () => {
    const io = fakeRailway();
    await runSetup(OPTS, io);
    const verbs = io.calls.map((a) => a[0]);
    for (const forbidden of FORBIDDEN_VERBS) expect(verbs).not.toContain(forbidden);
  });

  it("refuses its own command if one is ever constructed — restraint is executable", () => {
    const io = fakeRailway();
    const railway = makeRailway(io);
    expect(() => railway(["up"])).toThrow(/refused its own command/i);
    expect(() => railway(["redeploy"])).toThrow(/refused its own command/i);
    expect(io.exec).not.toHaveBeenCalled(); // blocked before reaching the CLI
  });

  it("hands the deploy to the GitHub integration instead of running one", async () => {
    const io = fakeRailway();
    const r = await runSetup(OPTS, io);
    expect(r.phase).toBe("awaiting-github-connection");
    expect(io.log.mock.calls.flat().join("\n")).toMatch(/GitHub Repo|Push to main/i);
  });
});

describe("writes are gated on a verified pin", () => {
  it("aborts before creating anything when the directory is linked elsewhere", async () => {
    const io = fakeRailway({ linkedTo: "kula" });
    await expect(runSetup(OPTS, io)).rejects.toThrow(/already linked.*kula/is);
    expect(io.calls.map((a) => a[0])).not.toContain("init"); // nothing was created
  });

  it("refuses a write whose pinned target does not match the live link", () => {
    const io = fakeRailway();
    const railway = makeRailway(io);
    expect(() =>
      railway(["variables", "--set", "X=1"], { write: true, pin: "aios-acme", status: { name: "kula" } })
    ).toThrow(/refusing to write/i);
  });

  it("refuses a write with no pin at all rather than defaulting to the ambient link", () => {
    const railway = makeRailway(fakeRailway());
    expect(() => railway(["variables", "--set", "X=1"], { write: true })).toThrow(/no pinned target/i);
  });

  it("pins before the first write in a real run", async () => {
    const io = fakeRailway();
    await runSetup(OPTS, io);
    const verbs = io.calls.map((a) => a[0]);
    // status (pin) must precede the first mutating verb (add/variables/domain)
    const firstWrite = verbs.findIndex((v) => ["add", "variables", "domain"].includes(v));
    expect(verbs.slice(0, firstWrite)).toContain("status");
  });
});

describe("project naming is enforced up front", () => {
  it("rejects a slug that cannot yield an AIOS project name", async () => {
    await expect(runSetup({ ...OPTS, slug: "!!!" }, fakeRailway())).rejects.toThrow(/valid AIOS project name/i);
  });

  it("creates the project under the aios- prefix service-guard requires", async () => {
    const io = fakeRailway();
    await runSetup(OPTS, io);
    const init = io.calls.find((a) => a[0] === "init");
    expect(init).toEqual(["init", "--name", "aios-acme"]);
  });
});

describe("variables — the silent-failure set", () => {
  it("always sets PGSSL, which managed Postgres rejects connections without", () => {
    expect(buildVariables({ appUrl: "https://x.up.railway.app" }).PGSSL).toBe("require");
  });

  it("references the Postgres service rather than copying a URL that would go stale", () => {
    expect(buildVariables({}).DATABASE_URL).toBe("${{Postgres.DATABASE_URL}}");
  });

  it("takes APP_URL from the real domain, since a guessed one breaks every invite link", async () => {
    const io = fakeRailway();
    await runSetup(OPTS, io);
    const setCall = io.calls.find((a) => a[0] === "variables")!;
    expect(setCall.join(" ")).toContain("APP_URL=https://aios-acme.up.railway.app");
  });

  it("omits optional keys entirely rather than setting them empty", () => {
    const v = buildVariables({ appUrl: "https://x", authSecret: "a", secretsKey: "b" });
    expect(v).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(v).not.toHaveProperty("RESEND_API_KEY");
  });

  it("renders repeated --set pairs", () => {
    expect(toVariableArgs({ A: "1", B: "2" })).toEqual(["--set", "A=1", "--set", "B=2"]);
  });
});

describe("generated secrets satisfy the checks that would otherwise fail later", () => {
  it("SECRETS_KEY decodes to exactly 32 bytes — any other width 500s the first connector save", () => {
    for (let i = 0; i < 20; i++) {
      expect(Buffer.from(generateSecrets().secretsKey, "base64")).toHaveLength(32);
    }
  });

  it("AUTH_SECRET clears the >=16 char minimum", () => {
    expect(generateSecrets().authSecret.length).toBeGreaterThanOrEqual(16);
  });

  it("does not print secrets to the log", async () => {
    const io = fakeRailway();
    await runSetup(OPTS, io);
    const logged = io.log.mock.calls.flat().join("\n");
    const varsArg = io.calls.find((a) => a[0] === "variables")!.join(" ");
    const secret = /AUTH_SECRET=(\w+)/.exec(varsArg)![1];
    expect(logged).not.toContain(secret);
  });
});

describe("resumption", () => {
  it("resumes at the first incomplete phase", () => {
    expect(nextPhase({ projectExists: false })).toBe("create");
    expect(nextPhase({ projectExists: true, databaseExists: false })).toBe("database");
    expect(nextPhase({ projectExists: true, databaseExists: true, variablesSet: true, domainSet: true, deployed: false })).toBe("await-deploy");
    expect(nextPhase({ projectExists: true, databaseExists: true, variablesSet: true, domainSet: true, deployed: true, teamExists: true })).toBe("done");
  });

  it("surfaces the once-shown admin password instead of burying it in output", async () => {
    const io = fakeRailway({ linkedTo: "aios-acme" });
    const r = await finishSetup(OPTS, io);
    expect(r.password).toBe("s3cret-pw-x");
  });

  it("creates the team and admin through `railway run`, the only place DATABASE_URL resolves", async () => {
    const io = fakeRailway({ linkedTo: "aios-acme" });
    await finishSetup(OPTS, io);
    const runs = io.calls.filter((a) => a[0] === "run");
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.map((a) => a.join(" ")).join("\n")).toMatch(/create-team.*\n.*create-member/s);
  });
});
