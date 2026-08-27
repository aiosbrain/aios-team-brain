import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DOCKERPROD-2 — the runner stage's contract (spec: docs/design/dockerprod2-deflake.md).
 *
 * Railway's GitHub integration builds this root `Dockerfile` for PRODUCTION. Its runner stage used
 * to re-read the BUILD CONTEXT for a single file (`COPY docker/entrypoint.sh /usr/local/bin/…`) that
 * the image already carried via `COPY --from=build /app ./` — and that instruction failed two
 * production deploys, each time blocking a merged fix for hours.
 *
 * Deleting it, on its own, would have traded a BUILD failure for a RUNTIME one: a build stage missing
 * the boot chain would yield a green image and a container that dies at boot. So the contract this
 * guard pins is three-part, and every part traces to a defect a reviewer actually produced against an
 * earlier draft of the spec:
 *
 *   AC1  the final stage's FILESYSTEM comes from earlier stages of this file and nothing else
 *   AC2  the boot invocation is complete (ENTRYPOINT *and* CMD), build-asserted, and TERMINAL
 *   AC3  the deploy contract is asserted where it is actually configured (header + railway.json)
 *
 * The parser FAILS LOUDLY rather than skipping: an unclassifiable instruction, an unresolvable
 * `--from`, a duplicate stage name or an empty final stage is a failure, not a pass. A guard that
 * silently skips what it cannot classify passes on the defect.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const ENTRYPOINT_SCRIPT = readFileSync(join(ROOT, "docker", "entrypoint.sh"), "utf8");
const RAILWAY_JSON = readFileSync(join(ROOT, "railway.json"), "utf8");

/** The image root every in-container path is resolved against (`WORKDIR /app` in the base stage). */
const IMAGE_ROOT = "/app";

/**
 * Instructions that cannot change the filesystem, and may therefore follow the boot-chain assertion.
 * An ALLOWLIST on purpose: an instruction nobody thought about fails closed rather than sneaking in
 * behind the assertion the way `RUN rm …` would.
 */
const NON_FILESYSTEM_OPS = new Set([
  "ENV",
  "EXPOSE",
  "LABEL",
  "ARG",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "ENTRYPOINT",
  "CMD",
]);

const KNOWN_OPS = new Set([
  "FROM",
  "RUN",
  "CMD",
  "LABEL",
  "EXPOSE",
  "ENV",
  "ADD",
  "COPY",
  "ENTRYPOINT",
  "VOLUME",
  "USER",
  "WORKDIR",
  "ARG",
  "ONBUILD",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
  "MAINTAINER",
]);

type Instruction = { op: string; args: string; line: number };
type Stage = { name: string | null; from: string; instructions: Instruction[]; line: number };

/**
 * A deliberately strict Dockerfile parser. Joins `\` continuations, drops comment lines (docker
 * drops them mid-continuation too), and throws on anything it cannot classify.
 */
export function parseDockerfile(text: string): { stages: Stage[]; all: Instruction[] } {
  const raw = text.split("\n");
  const joined: Instruction[] = [];
  let buffer = "";
  let bufferLine = 0;

  const flush = () => {
    const trimmed = buffer.trim();
    buffer = "";
    if (!trimmed) return;
    const m = trimmed.match(/^([A-Za-z]+)\s*([\s\S]*)$/);
    if (!m) throw new Error(`Dockerfile line ${bufferLine}: cannot classify instruction: ${trimmed}`);
    const op = m[1].toUpperCase();
    if (!KNOWN_OPS.has(op)) {
      throw new Error(`Dockerfile line ${bufferLine}: unknown instruction \`${op}\``);
    }
    joined.push({ op, args: m[2].trim(), line: bufferLine });
  };

  raw.forEach((lineText, i) => {
    const lineNo = i + 1;
    if (/^\s*#/.test(lineText)) return; // comment — dropped even mid-continuation
    if (!buffer && !lineText.trim()) return;
    if (!buffer) bufferLine = lineNo;
    if (/\\\s*$/.test(lineText)) {
      buffer += lineText.replace(/\\\s*$/, " ");
      return;
    }
    buffer += lineText;
    flush();
  });
  flush();

  const stages: Stage[] = [];
  for (const ins of joined) {
    if (ins.op === "FROM") {
      const m = ins.args.match(/^(\S+)(?:\s+[Aa][Ss]\s+(\S+))?\s*$/);
      if (!m) throw new Error(`Dockerfile line ${ins.line}: cannot parse FROM: ${ins.args}`);
      stages.push({ name: m[2] ?? null, from: m[1], instructions: [], line: ins.line });
    } else {
      if (stages.length === 0) continue; // pre-FROM ARG etc.
      stages[stages.length - 1].instructions.push(ins);
    }
  }
  if (stages.length === 0) throw new Error("Dockerfile declares no stages");
  return { stages, all: joined };
}

const parsed = parseDockerfile(DOCKERFILE);
/** FINAL = the last `FROM` in file order, i.e. the default build target — what compose and Railway build. */
const finalStage = parsed.stages[parsed.stages.length - 1];
const earlierStageNames = new Set(
  parsed.stages.slice(0, -1).map((s) => s.name).filter((n): n is string => n !== null)
);

/** `--from=<value>` on a COPY/RUN-mount, or null when the flag is absent. */
function fromFlag(args: string): string | null {
  const m = args.match(/(?:^|\s)--from=(\S+)/);
  return m ? m[1] : null;
}

/** The ENTRYPOINT's exec-form argv, or null if it is not a JSON array. */
function execForm(args: string): string[] | null {
  if (!args.trim().startsWith("[")) return null;
  try {
    const v = JSON.parse(args);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

/** Collapse runs of whitespace so a multi-line `RUN` compares by content, not by formatting. */
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function only(op: string): Instruction[] {
  return finalStage.instructions.filter((i) => i.op === op);
}

describe("AC1 — the final stage's filesystem comes from earlier stages of this file, and nothing else", () => {
  it("(a) the final stage's own FROM names an earlier declared stage", () => {
    expect(
      earlierStageNames.has(finalStage.from),
      `The final stage is \`FROM ${finalStage.from}\`, which is not a stage declared earlier in this ` +
        `Dockerfile (declared: ${[...earlierStageNames].join(", ")}). An external base here builds ` +
        `green and boots dead — e.g. busybox has no \`node\` for docker/entrypoint.sh:5.`
    ).toBe(true);
  });

  it("(b) the final stage contains no ADD — ADD reads the build context too", () => {
    expect(only("ADD").map((i) => `line ${i.line}: ADD ${i.args}`)).toEqual([]);
  });

  it("(c) every final-stage COPY reads from an earlier declared stage", () => {
    const offenders = only("COPY").map((i) => {
      const from = fromFlag(i.args);
      if (from === null) return `line ${i.line}: COPY with no --from= (reads the BUILD CONTEXT)`;
      if (!earlierStageNames.has(from)) {
        return `line ${i.line}: COPY --from=${from} — not a stage declared earlier in this file ` +
          `(a named context or external image, not the build stage)`;
      }
      return null;
    });
    expect(offenders.filter(Boolean)).toEqual([]);
  });

  it("(d) no final-stage RUN carries a --mount of any kind", () => {
    // Forbidden outright rather than allowlisted: with `type=` omitted buildkit defaults to bind and
    // with `from=` omitted it defaults to the BUILD CONTEXT, so an allowlist would have to model
    // those defaults correctly to be safe. Nothing here needs a mount.
    const offenders = only("RUN")
      .filter((i) => /(?:^|\s)--mount[=\s]/.test(i.args))
      .map((i) => `line ${i.line}: RUN --mount…`);
    expect(offenders).toEqual([]);
  });

  it("(e) no ONBUILD anywhere in the file — it fires INSIDE the inheriting stage", () => {
    // Measured, because the two spec reviewers disagreed about it (spec §0e): with
    // `FROM busybox AS base / ONBUILD COPY x / FROM base AS runner`, buildkit prints
    // `[runner 1/2] ONBUILD COPY x` — a context read attributed to the runner stage while appearing
    // in no runner-stage instruction. A final-stage-only check cannot see it.
    expect(parsed.all.filter((i) => i.op === "ONBUILD").map((i) => `line ${i.line}`)).toEqual([]);
  });

  it("(f) the final stage is non-empty and every stage name is unique — the parser must not pass vacuously", () => {
    expect(finalStage.instructions.length).toBeGreaterThan(0);
    const names = parsed.stages.map((s) => s.name).filter(Boolean);
    expect(
      names.filter((n, i) => names.indexOf(n) !== i),
      "Duplicate stage name — docker resolves it last-wins, silently"
    ).toEqual([]);
    // An unresolvable --from must fail rather than be skipped.
    const unresolvable = only("COPY")
      .map((i) => fromFlag(i.args))
      .filter((f): f is string => f !== null && (/^\d+$/.test(f) || f.includes("$")));
    expect(unresolvable, "Numeric or ARG-substituted --from cannot be statically resolved").toEqual([]);
  });
});

/**
 * The paths the boot chain needs, derived rather than hardcoded: the ENTRYPOINT's own script, plus
 * every absolute `/app/…` path that script goes on to execute. Adding a new boot dependency to
 * `docker/entrypoint.sh` therefore extends what the image must assert, automatically.
 */
const entrypointArgv = (() => {
  const ins = only("ENTRYPOINT");
  return ins.length === 1 ? execForm(ins[0].args) : null;
})();

const bootPaths: string[] = (() => {
  const script = entrypointArgv?.[1];
  const referenced = [...ENTRYPOINT_SCRIPT.matchAll(/(\/app\/[A-Za-z0-9_./-]+)/g)].map((m) => m[1]);
  return [...new Set([...(script ? [script] : []), ...referenced])];
})();

/**
 * The final stage's boot-chain assertion, located by its `set -eu` preamble.
 *
 * Located by PREAMBLE and not by content: keying on `test -f` made a mutation that WEAKENS the
 * assertion (dropping `-f`) also unfindable, so it reddened (c), (d) and (e) at once and proved
 * only whichever ran first. The preamble is stable under exactly the mutations (c) exists to catch.
 */
const assertionIndex = finalStage.instructions.findIndex(
  (i) => i.op === "RUN" && /^set\s+-eu\b/.test(i.args.trim())
);

describe("AC2 — the boot invocation is complete, build-asserted, and terminal", () => {
  it("(a) ENTRYPOINT is present and is exactly [\"/bin/sh\", \"<path>\"]", () => {
    const ins = only("ENTRYPOINT");
    expect(ins.length, "exactly one ENTRYPOINT — absence is not a shape the guard may skip").toBe(1);
    const argv = execForm(ins[0].args);
    expect(argv, `ENTRYPOINT must be JSON exec form, got: ${ins[0].args}`).not.toBeNull();
    expect(
      argv,
      "ENTRYPOINT must invoke through /bin/sh so the boot depends on nothing outside this file — " +
        "not the executable bit, not /usr/bin/env, not PATH"
    ).toHaveLength(2);
    expect(argv?.[0]).toBe("/bin/sh");
  });

  it("(b) CMD is present, exec-form and non-empty — an empty CMD exits 0 at boot, silently", () => {
    // docker/entrypoint.sh ends in `exec "$@"`, and POSIX `exec` with zero arguments is a NO-OP:
    // the script falls off the end and returns 0. Green build, container gone, no error anywhere.
    const ins = only("CMD");
    expect(ins.length, "exactly one CMD").toBe(1);
    const argv = execForm(ins[0].args);
    expect(argv, `CMD must be JSON exec form, got: ${ins[0].args}`).not.toBeNull();
    // Non-empty is NOT the invariant — `CMD ["true"]` is non-empty and boots a container that exits
    // 0 having served nothing. What must hold is that CMD runs a DEFINED npm script of this package,
    // derived from package.json rather than pinned to a literal.
    expect(argv?.[0], "CMD must invoke npm").toBe("npm");
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
    expect(
      Object.keys(scripts),
      `CMD runs \`npm ${argv?.[1]}\`, which package.json does not define`
    ).toContain(argv?.[1]);
  });

  it("(c) the assertion is EXACTLY the derived boot-chain check — no more, no less", () => {
    expect(bootPaths.length, "derived boot paths must not be empty").toBeGreaterThan(0);
    expect(assertionIndex, "no boot-chain assertion (`RUN … test -f …`) in the final stage").toBeGreaterThanOrEqual(0);
    // WHOLE-INSTRUCTION equality, not `contains`. A `contains` check accepts
    // `RUN <assertion> && rm /app/docker/entrypoint.sh` — the assertion runs, passes, and then
    // destroys what it just observed, inside ONE instruction that AC2(d)'s look-ahead cannot see.
    // Equality also makes the Dockerfile line a DERIVED artifact: add a boot dependency to
    // docker/entrypoint.sh and this reddens until the Dockerfile is updated to match.
    //
    // `-r` alone is nearly `-e` as root, and passes on a directory and on a zero-byte file — both of
    // which still build green and boot dead. Hence -f and -s too.
    // Each test EXITS EXPLICITLY. The first version chained them with `&&` under `set -eu`, which
    // does not fail: POSIX ignores errexit for a command in an AND-OR list, so a missing boot file
    // fell through and the image built green. Pinning the exact text is what stops that shape
    // coming back — a static guard cannot otherwise tell a working assertion from a decorative one.
    const fail = (msg: string) => `|| { echo "boot chain: $f ${msg}" >&2; exit 1; }`;
    const expected =
      `set -eu; for f in ${bootPaths.join(" ")}; do ` +
      `test -f "$f" ${fail("is missing or not a regular file")}; ` +
      `test -s "$f" ${fail("is empty")}; ` +
      `test -r "$f" ${fail("is not readable")}; done; ` +
      `/bin/sh -n ${entrypointArgv?.[1]}`;
    expect(normalise(finalStage.instructions[assertionIndex].args)).toBe(normalise(expected));
  });

  it("(d) the assertion is TERMINAL — nothing that can touch the filesystem follows it", () => {
    // `RUN test -r X` followed by `RUN rm X` is exactly the rm-after-copy hole the assertion exists
    // to close, and a "contains an assertion" check accepts it.
    const after = finalStage.instructions.slice(assertionIndex + 1);
    const offenders = after
      .filter((i) => !NON_FILESYSTEM_OPS.has(i.op))
      .map((i) => `line ${i.line}: ${i.op} — can invalidate what the assertion observed`);
    expect(offenders).toEqual([]);
  });

  it("(e) the ENTRYPOINT's script is one of the asserted paths", () => {
    const body = finalStage.instructions[assertionIndex]?.args ?? "";
    expect(body).toContain(entrypointArgv?.[1] ?? "<no entrypoint>");
  });

  it("(f) every asserted path corresponds, under /app, to a file tracked in the repo", () => {
    // The WEAKEST leg, and labelled so: it observes the repo, not the image. (c)+(d) are what
    // observe the image — a copy from the wrong stage passes this and fails those.
    for (const p of bootPaths) {
      expect(p.startsWith(`${IMAGE_ROOT}/`), `${p} is not under ${IMAGE_ROOT}`).toBe(true);
      const repoPath = join(ROOT, p.slice(IMAGE_ROOT.length + 1));
      expect(() => readFileSync(repoPath), `${p} has no counterpart at ${repoPath}`).not.toThrow();
    }
  });
});

/**
 * The sentinel sentences, verbatim from spec §2b. Quoted in BOTH places on purpose: a prose guard
 * that only requires the word "Railway" is satisfied by "Railway never builds this Dockerfile."
 */
const SENTINELS = [
  "Railway's GitHub integration auto-detects this root Dockerfile and BUILDS PRODUCTION with it.",
  "Railway overrides this image's ENTRYPOINT/CMD with railway.json's startCommand, so the entrypoint below is the local `docker compose` path only.",
];
const RETIRED = "It is NOT wired into the Railway deploy path";

describe("AC3 — the deploy contract is asserted where it is actually configured", () => {
  it("(a) the retired sentence is gone", () => {
    expect(DOCKERFILE.includes(RETIRED), `Dockerfile still claims: "${RETIRED}" — it is false`).toBe(false);
  });

  it("(b) the header states both halves of the contract, verbatim", () => {
    for (const s of SENTINELS) expect(DOCKERFILE, `header is missing: ${s}`).toContain(s);
  });

  it("(c) railway.json still carries a non-empty deploy.startCommand", () => {
    // This is what makes the header's second sentence TRUE, and it lives in a different file.
    // Delete it and Railway falls back to the image ENTRYPOINT — the spec's §0c and its
    // no-staging-gate rationale both silently become false while every prose check still passes.
    const cfg = JSON.parse(RAILWAY_JSON);
    expect(typeof cfg?.deploy?.startCommand).toBe("string");
    expect((cfg.deploy.startCommand as string).trim().length).toBeGreaterThan(0);
  });
});

describe("the parser discriminates (non-vacuity)", () => {
  it("throws on an unknown instruction rather than skipping it", () => {
    expect(() => parseDockerfile("FROM a AS b\nFROBNICATE x\n")).toThrow(/unknown instruction/i);
  });

  it("joins line continuations into one instruction", () => {
    const p = parseDockerfile("FROM a AS b\nRUN one \\\n  && two\n");
    expect(p.stages[0].instructions).toHaveLength(1);
    expect(p.stages[0].instructions[0].args).toMatch(/one\s+&&\s+two/);
  });

  it("drops comments, including mid-continuation", () => {
    const p = parseDockerfile("FROM a AS b\nRUN one \\\n# a comment\n  && two\n");
    expect(p.stages[0].instructions).toHaveLength(1);
    expect(p.stages[0].instructions[0].args).not.toContain("comment");
  });

  it("reads --from and exec form", () => {
    expect(fromFlag("--from=build /app ./")).toBe("build");
    expect(fromFlag("/app ./")).toBeNull();
    expect(execForm('["/bin/sh", "/x"]')).toEqual(["/bin/sh", "/x"]);
    expect(execForm("npm start")).toBeNull(); // shell form is not a shape this guard may accept
  });
});
