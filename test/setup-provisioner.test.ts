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
  redactSecretsForPlan,
  runSetup,
  toVariableArgs,
} from "../scripts/setup.mjs";
import { FORBIDDEN_VERBS } from "../scripts/railway-policy.mjs";

/** A fake Railway CLI that records every invocation and answers plausibly. */
function fakeRailway({
  linkedTo = null,
  existingVars = null,
  varsReadFails = false,
}: {
  linkedTo?: string | null;
  /** What `railway variables --json` reports — i.e. the environment already on the project. */
  existingVars?: Record<string, string> | null;
  varsReadFails?: boolean;
} = {}) {
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
    // A read: `variables --json` with no --set. Distinct from the write below.
    if (verb === "variables" && args.includes("--json") && !args.includes("--set")) {
      if (varsReadFails) return { status: 1, stdout: "", stderr: "no service found" };
      return { status: 0, stdout: JSON.stringify(existingVars ?? {}), stderr: "" };
    }
    if (verb === "domain") return { status: 0, stdout: "https://aios-acme.up.railway.app", stderr: "" };
    if (verb === "run") {
      return { status: 0, stdout: "✓ member you@acme.com\n✓ password set (copy now, shown once): s3cret-pw-x", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  return { exec, calls, log: vi.fn() };
}

/** The `K=V` pairs of the `variables --set` write, as a map. */
function varsWritten(calls: string[][]): Record<string, string> {
  const call = calls.find((a) => a[0] === "variables" && a.includes("--set"));
  if (!call) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < call.length; i++) {
    if (call[i] !== "--set") continue;
    const eq = call[i + 1].indexOf("=");
    out[call[i + 1].slice(0, eq)] = call[i + 1].slice(eq + 1);
  }
  return out;
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

// Spec: the script calls itself "resumable and idempotent", and the skill tells you to re-run
// after fixing a failure. So a second run must not be destructive. Rotating these two is exactly
// that: AUTH_SECRET invalidates every session, and SECRETS_KEY orphans every connector token,
// which is encrypted at rest with it (README §5). compose.yml already persists both for this
// reason — the Railway path has to hold the same line.
describe("re-provisioning preserves secrets that already exist", () => {
  const EXISTING = {
    AUTH_SECRET: "existing-auth-secret-do-not-rotate",
    SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  };

  it("reuses both secrets rather than generating new ones", async () => {
    const io = fakeRailway({ linkedTo: "aios-acme", existingVars: EXISTING });
    await runSetup(OPTS, io);
    const written = varsWritten(io.calls);
    expect(written.AUTH_SECRET).toBe(EXISTING.AUTH_SECRET);
    expect(written.SECRETS_KEY).toBe(EXISTING.SECRETS_KEY);
  });

  it("still generates both for a brand-new project, where there is nothing to preserve", async () => {
    const io = fakeRailway(); // nothing linked → the run creates the project
    await runSetup(OPTS, io);
    const written = varsWritten(io.calls);
    expect(written.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(written.SECRETS_KEY, "base64")).toHaveLength(32);
  });

  it("generates only the half that is missing", async () => {
    const io = fakeRailway({ linkedTo: "aios-acme", existingVars: { AUTH_SECRET: EXISTING.AUTH_SECRET } });
    await runSetup(OPTS, io);
    const written = varsWritten(io.calls);
    expect(written.AUTH_SECRET).toBe(EXISTING.AUTH_SECRET);
    expect(Buffer.from(written.SECRETS_KEY, "base64")).toHaveLength(32); // absent → generated
  });

  it("aborts rather than overwriting secrets it could not read", async () => {
    // Fail closed. A transient read failure that fell through to "generate" would silently
    // destroy a live instance's tokens — the worst possible outcome of a retry.
    const io = fakeRailway({ linkedTo: "aios-acme", varsReadFails: true });
    await expect(runSetup(OPTS, io)).rejects.toThrow(/could not read the existing environment/i);
    expect(io.calls.filter((a) => a[0] === "variables" && a.includes("--set"))).toHaveLength(0);
  });

  it("preserves a malformed existing SECRETS_KEY and warns, instead of silently replacing it", async () => {
    // Replacing it would "fix" the width by orphaning every token encrypted under it. Naming
    // the problem is correct; deciding to destroy data on the user's behalf is not.
    const io = fakeRailway({
      linkedTo: "aios-acme",
      existingVars: { ...EXISTING, SECRETS_KEY: Buffer.alloc(35, 1).toString("base64") },
    });
    await runSetup(OPTS, io);
    expect(varsWritten(io.calls).SECRETS_KEY).toBe(Buffer.alloc(35, 1).toString("base64"));
    // Names the key AND the required width — not a bare mention of "doctor", which any future
    // log line could satisfy.
    expect(io.log.mock.calls.flat().join("\n")).toMatch(/SECRETS_KEY[^\n]*35 bytes, not 32/i);
  });

  it("aborts when the read succeeds but does not yield an environment map", async () => {
    // `[]` and `"ok"` are truthy and parse fine. Treating either as "no secrets present" would
    // fall straight through to generating fresh ones — the exact outcome the abort exists for.
    for (const stdout of ["[]", '"ok"', "42", "null"]) {
      const io = fakeRailway({ linkedTo: "aios-acme" });
      io.exec.mockImplementation((_c: string, args: string[]) => {
        io.calls.push(args);
        if (args[0] === "whoami") return { status: 0, stdout: "you@example.com", stderr: "" };
        if (args[0] === "status") return { status: 0, stdout: JSON.stringify({ name: "aios-acme" }), stderr: "" };
        if (args[0] === "variables" && args.includes("--json")) return { status: 0, stdout, stderr: "" };
        if (args[0] === "domain") return { status: 0, stdout: "https://aios-acme.up.railway.app", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      await expect(runSetup(OPTS, io)).rejects.toThrow(/could not read the existing environment/i);
      expect(io.calls.filter((a) => a[0] === "variables" && a.includes("--set"))).toHaveLength(0);
    }
  });

  it("accepts an empty environment — a created-but-unconfigured project generates both", async () => {
    const io = fakeRailway({ linkedTo: "aios-acme", existingVars: {} });
    await runSetup(OPTS, io);
    const written = varsWritten(io.calls);
    expect(written.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(written.SECRETS_KEY, "base64")).toHaveLength(32);
  });
});

describe("the dry-run plan neither leaks nor misrepresents", () => {
  it("masks secret values, so no plan line is a paste-ready rotation command", () => {
    const plan = redactSecretsForPlan(
      "railway variables --set AUTH_SECRET=deadbeefcafe --set SECRETS_KEY=aGVsbG8= --set PGSSL=require"
    );
    expect(plan).not.toContain("deadbeefcafe");
    expect(plan).not.toContain("aGVsbG8=");
    expect(plan).toContain("PGSSL=require"); // non-secrets stay legible
    expect(plan).toContain("AUTH_SECRET=<generated-or-preserved>");
  });

  it("predicts preservation truthfully, because the reads are real", async () => {
    // The plan must not show a rotation a real run would not perform.
    const io = fakeRailway({
      linkedTo: "aios-acme",
      existingVars: { AUTH_SECRET: "live", SECRETS_KEY: Buffer.alloc(32, 3).toString("base64") },
    });
    await runSetup({ ...OPTS, dryRun: true }, io);
    const logged = io.log.mock.calls.flat().join("\n");
    expect(logged).toMatch(/preserving existing AUTH_SECRET \+ SECRETS_KEY/i);
    expect(logged).not.toContain("live"); // and still never echoes the value
  });

  it("performs the reads but none of the writes", async () => {
    const io = fakeRailway({ linkedTo: "aios-acme", existingVars: {} });
    await runSetup({ ...OPTS, dryRun: true }, io);
    const verbs = io.calls.map((a) => a[0]);
    expect(verbs).toContain("status"); // read → really ran
    expect(io.calls.filter((a) => a[0] === "variables" && a.includes("--set"))).toHaveLength(0);
    for (const write of ["init", "add", "domain", "run"]) expect(verbs).not.toContain(write);
  });

  it("a dry run now catches the link drift a real run aborts on", async () => {
    // Previously the faked `status` read made every dry run look clean from a drifted directory.
    const io = fakeRailway({ linkedTo: "kula" });
    await expect(runSetup({ ...OPTS, dryRun: true }, io)).rejects.toThrow(/already linked.*kula/is);
  });

  it("does not read the environment at all for a brand-new project", async () => {
    // There is nothing to preserve, and the read would target a service that does not exist yet.
    const io = fakeRailway();
    await runSetup(OPTS, io);
    expect(io.calls.filter((a) => a[0] === "variables" && a.includes("--json"))).toHaveLength(0);
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
