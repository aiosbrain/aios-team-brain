import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runRecordedBuild } from "./http/dev-login-build-record";
import {
  BUILD_RECORD_COMMAND,
  BUILD_RECORD_FILE,
  DevLoginSetupFailure,
  NEXT_LOADED_ENV_FILES,
  assertBuildRecordCurrent,
  inventoryServerJs,
  type BuildRecord,
  type SetupFailureKind,
} from "./http/dev-login-dev-setup";

// Spec (AIO-1210 AC08/AC10, docs/design/aio1210-dev-login.md): the dev-login wire carrier consumes a
// production build it did not make, so it may credit that build only when something OBSERVED it
// being built from the current sources — "a stale/copied build is not proof". These cases pin both
// halves on synthetic checkouts in disposable temp directories:
//
//   - the recorder writes a record only for a command it ran itself that exited 0 with the tracked
//     sources unchanged, and never when a Next-loaded env file is present;
//   - the carrier-side check refuses a build with no record, a record whose own claims do not hold,
//     and a record the checkout or the artifact has since moved away from.
//
// The "build" is a real child process (a generated Node script standing in for one command), so the
// exit status is a real one. Nothing here runs `next`, opens a socket or touches the task checkout.

const ROUTE = join("app", "auth", "dev-login", "route.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A synthetic checkout: just enough tracked sources to fingerprint. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "aio1210-build-record-"));
  roots.push(dir);
  expect(realpathSync(dir).startsWith(realpathSync(process.cwd()) + sep)).toBe(false);
  write(dir, ROUTE, "// synthetic route source\n");
  write(dir, "package.json", "{}\n");
  return dir;
}

/**
 * A stand-in build COMMAND. Like `next build` it clears `.next` first, then emits the files the
 * carrier reads; it can also exit non-zero or edit a tracked source while it runs.
 */
function fakeBuild(dir: string, opts: { buildId?: string; exitCode?: number; editSource?: boolean } = {}): string[] {
  const script = join(dir, "fake-build.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
      'import { dirname } from "node:path";',
      "const out = (rel, text) => { mkdirSync(dirname(rel), { recursive: true }); writeFileSync(rel, text); };",
      'rmSync(".next", { recursive: true, force: true });',
      `out(".next/BUILD_ID", ${JSON.stringify(opts.buildId ?? "synthetic-build-1")});`,
      'out(".next/server/app-paths-manifest.json", JSON.stringify({ "/auth/dev-login/route": "app/auth/dev-login/route.js" }));',
      'out(".next/server/app/auth/dev-login/route.js", "// synthetic entry\\n");',
      'out(".next/server/chunks/handler.js", "// synthetic handler chunk\\n");',
      'out(".next/server/chunks/handler.js.map", "{}");',
      'out(".next/prerender-manifest.json", JSON.stringify({ routes: {} }));',
      'out("build-ran.sentinel", "ran");',
      opts.editSource ? 'appendFileSync("app/auth/dev-login/route.ts", "// edited during the build\\n");' : "",
      `process.exit(${opts.exitCode ?? 0});`,
      "",
    ].join("\n")
  );
  return [process.execPath, script];
}

function failureOf(run: () => unknown): DevLoginSetupFailure {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(DevLoginSetupFailure);
  return thrown as DevLoginSetupFailure;
}

function expectFailure(run: () => unknown, kind: SetupFailureKind): DevLoginSetupFailure {
  const failure = failureOf(run);
  expect(failure.kind).toBe(kind);
  expect(failure.message).toContain(`SETUP_FAILURE[${kind}]`);
  return failure;
}

const recordFile = (dir: string): string => join(dir, BUILD_RECORD_FILE);
const readRecord = (dir: string): BuildRecord => JSON.parse(readFileSync(recordFile(dir), "utf8")) as BuildRecord;

/** A checkout holding a recorded stand-in build, plus the command that record names. */
function recorded(): { dir: string; command: string[]; record: BuildRecord } {
  const dir = checkout();
  const command = fakeBuild(dir);
  return { dir, command, record: runRecordedBuild(dir, command) };
}

describe("server JS inventory (pure)", () => {
  const emit = (dir: string, files: [string, string][]): void => {
    for (const [rel, text] of files) write(dir, join(".next", "server", rel), text);
  };
  const FILES: [string, string][] = [
    ["app/auth/dev-login/route.js", "entry"],
    ["chunks/a.js", "chunk a"],
    ["chunks/ssr/b.js", "chunk b"],
    ["webpack-runtime.js", "runtime"],
  ];

  it("is deterministic: the same emitted files hash the same whatever order they were written in", () => {
    const forward = checkout();
    const reverse = checkout();
    emit(forward, FILES);
    emit(reverse, [...FILES].reverse());

    const a = inventoryServerJs(forward);
    const b = inventoryServerJs(reverse);
    expect(a.hash).toBe(b.hash);
    expect(a.entries).toEqual(b.entries);
    expect(Object.keys(a.entries)).toEqual(FILES.map(([rel]) => rel).sort());
    expect(a.files).toBe(4);
    expect(a.bytes).toBe(FILES.reduce((sum, [, text]) => sum + text.length, 0));
    expect(a.nonRegular).toBe(0);
  });

  it("covers JS only: source maps, other files and a dev server's .next/dev output never enter", () => {
    const dir = checkout();
    emit(dir, FILES);
    const before = inventoryServerJs(dir);

    emit(dir, [
      ["chunks/a.js.map", "{}"],
      ["app-paths-manifest.json", "{}"],
      ["app/auth/dev-login/route.js.nft.json", "{}"],
    ]);
    write(dir, join(".next", "dev", "server", "chunks", "a.js"), "dev output");
    expect(inventoryServerJs(dir)).toEqual(before);
  });

  it.each<[string, (dir: string) => void]>([
    ["a chunk's content changes", (dir) => write(dir, ".next/server/chunks/a.js", "chunk a, changed")],
    ["a chunk is added", (dir) => write(dir, ".next/server/chunks/new.js", "new")],
    ["a chunk is removed", (dir) => rmSync(join(dir, ".next/server/chunks/a.js"))],
    ["the route entry changes", (dir) => write(dir, ".next/server/app/auth/dev-login/route.js", "entry, changed")],
  ])("the hash moves when %s", (_name, mutate) => {
    const dir = checkout();
    emit(dir, FILES);
    const before = inventoryServerJs(dir);
    mutate(dir);
    expect(inventoryServerJs(dir).hash).not.toBe(before.hash);
  });

  it("a checkout with no server output is a named setup failure", () => {
    expectFailure(() => inventoryServerJs(checkout()), "build-missing");
  });
});

describe("dev-login build recorder (real child process, synthetic checkout)", () => {
  it("records a build only after watching it exit 0 with the sources unchanged, bound to BUILD_ID and the server JS", () => {
    const { dir, command, record } = recorded();

    expect(record.command).toEqual(command);
    expect(record.exitCode).toBe(0);
    expect(record.sourcesBefore).toEqual(record.sourcesAfter);
    expect(record.sourcesAfter[ROUTE.split(sep).join("/")]).toMatch(/^[0-9a-f]{64}$/);
    expect(record.buildId).toBe("synthetic-build-1");
    expect(record.routeEntry).toBe("app/auth/dev-login/route.js");
    const inventory = inventoryServerJs(dir);
    expect(record.serverJs).toEqual({ files: 2, bytes: inventory.bytes, nonRegular: 0, hash: inventory.hash });

    // The file on disk is that record, and the carrier-side check accepts it for this command.
    expect(readRecord(dir)).toEqual(record);
    const current = assertBuildRecordCurrent(dir, command);
    expect(current.record).toEqual(record);
    expect(current.artifact.buildId).toBe("synthetic-build-1");
    expect(current.serverJs.hash).toBe(record.serverJs.hash);
  });

  it("a failing build leaves no record, even though it left a complete artifact behind", () => {
    const dir = checkout();
    const failure = expectFailure(() => runRecordedBuild(dir, fakeBuild(dir, { exitCode: 3 })), "build-failed");
    expect(failure.message).toContain("status 3");
    // The artifact is all there — only the observed exit status says the build failed.
    expect(readFileSync(join(dir, ".next", "BUILD_ID"), "utf8")).toBe("synthetic-build-1");
    expect(existsSync(recordFile(dir))).toBe(false);
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-missing");
  });

  it("an earlier record does not survive a later failed build that leaves the old artifact in place", () => {
    const { dir } = recorded();
    expect(existsSync(recordFile(dir))).toBe(true);
    expectFailure(() => runRecordedBuild(dir, [process.execPath, "-e", "process.exit(4)"]), "build-failed");
    expect(existsSync(join(dir, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  it("a command that cannot be started is a build failure, not a record", () => {
    const dir = checkout();
    expectFailure(() => runRecordedBuild(dir, ["aio1210-no-such-build-command"]), "build-failed");
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  it("a tracked source edited while the build ran is refused: the artifact cannot be attributed to either version", () => {
    const dir = checkout();
    const failure = expectFailure(() => runRecordedBuild(dir, fakeBuild(dir, { editSource: true })), "build-source-changed");
    expect(failure.message).toContain("app/auth/dev-login/route.ts");
    expect(existsSync(join(dir, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(recordFile(dir))).toBe(false);
  });

  it.each([...NEXT_LOADED_ENV_FILES])("a checkout holding %s is refused before the build command runs", (name) => {
    const dir = checkout();
    const command = fakeBuild(dir);
    // A disposable temp checkout, never the task checkout; the file is empty and never read.
    writeFileSync(join(dir, name), "");
    const failure = expectFailure(() => runRecordedBuild(dir, command), "env-file-present");
    expect(failure.message).toContain(name);
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(false);
    expect(existsSync(join(dir, ".next"))).toBe(false);
  });

  it("a checkout holding only .env.example builds and records", () => {
    const dir = checkout();
    writeFileSync(join(dir, ".env.example"), "");
    expect(runRecordedBuild(dir, fakeBuild(dir)).exitCode).toBe(0);
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(true);
  });

  it("a directory that is not the task root is refused before the build command runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "aio1210-build-record-"));
    roots.push(dir);
    expectFailure(() => runRecordedBuild(dir, fakeBuild(dir)), "wrong-cwd");
    expect(existsSync(join(dir, "build-ran.sentinel"))).toBe(false);
  });
});

describe("dev-login carrier build-record check (read-only, synthetic checkout)", () => {
  it("a complete artifact nobody recorded is refused: its mere presence proves nothing about its sources", () => {
    const dir = checkout();
    const [file, ...args] = fakeBuild(dir);
    expect(spawnSync(file, args, { cwd: dir }).status).toBe(0);
    expect(existsSync(join(dir, ".next", "BUILD_ID"))).toBe(true);
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-missing");
  });

  it("the carrier accepts only a record of the ordinary build command", () => {
    const { dir, command } = recorded();
    expect(command).not.toEqual([...BUILD_RECORD_COMMAND]);
    expect(() => assertBuildRecordCurrent(dir, command)).not.toThrow();
    // With no command passed — as the carrier calls it — a stand-in build's record is not creditable.
    expectFailure(() => assertBuildRecordCurrent(dir), "build-record-invalid");
  });

  it.each<[string, (dir: string) => void, string]>([
    ["a tracked source edited since the build", (dir) => appendFileSync(join(dir, ROUTE), "// edited later\n"), "app/auth/dev-login/route.ts"],
    ["a tracked source deleted since the build", (dir) => rmSync(join(dir, "package.json")), "package.json"],
    ["a different BUILD_ID", (dir) => write(dir, ".next/BUILD_ID", "synthetic-build-2"), "BUILD_ID"],
    ["a changed route entry", (dir) => write(dir, ".next/server/app/auth/dev-login/route.js", "// other entry\n"), "entry"],
    ["a changed server chunk", (dir) => write(dir, ".next/server/chunks/handler.js", "// other chunk\n"), "server JS inventory"],
    ["an added server chunk", (dir) => write(dir, ".next/server/chunks/extra.js", "// extra\n"), "server JS inventory"],
    ["a removed server chunk", (dir) => rmSync(join(dir, ".next/server/chunks/handler.js")), "server JS inventory"],
  ])("a record is stale after %s", (_name, mutate, names) => {
    const { dir, command } = recorded();
    expect(() => assertBuildRecordCurrent(dir, command)).not.toThrow();
    mutate(dir);
    expect(expectFailure(() => assertBuildRecordCurrent(dir, command), "build-record-stale").message).toContain(names);
  });

  it("a record stays current across changes it does not cover: a source map, dev output, a generated file", () => {
    const { dir, command, record } = recorded();
    write(dir, ".next/server/chunks/handler.js.map", '{"changed":true}');
    write(dir, ".next/dev/server/chunks/handler.js", "// dev output\n");
    write(dir, "next-env.d.ts", "// generated\n");
    expect(assertBuildRecordCurrent(dir, command).record).toEqual(record);
  });

  it.each<[string, (record: BuildRecord) => unknown]>([
    ["a non-zero exit status", (record) => ({ ...record, exitCode: 1 })],
    ["sources that differ across the build", (record) => ({ ...record, sourcesBefore: { ...record.sourcesBefore, "package.json": "0".repeat(64) } })],
    ["another schema", (record) => ({ ...record, schema: 2 })],
    ["no exit status at all", (record) => ({ ...record, exitCode: undefined })],
    ["a success flag instead of observations", () => ({ schema: 1, ok: true, success: true })],
  ])("a record claiming %s is refused, not trusted", (_name, edit) => {
    const { dir, command, record } = recorded();
    writeFileSync(recordFile(dir), JSON.stringify(edit(record)));
    expectFailure(() => assertBuildRecordCurrent(dir, command), "build-record-invalid");
  });

  it("an unreadable record is refused", () => {
    const { dir, command } = recorded();
    writeFileSync(recordFile(dir), "not json");
    expectFailure(() => assertBuildRecordCurrent(dir, command), "build-record-invalid");
  });

  it("a record copied onto another checkout's identical artifact does not attribute it to different sources", () => {
    const built = recorded();
    const other = checkout();
    appendFileSync(join(other, ROUTE), "// a different source\n");
    const [file, ...args] = fakeBuild(other);
    expect(spawnSync(file, args, { cwd: other }).status).toBe(0);
    writeFileSync(recordFile(other), JSON.stringify({ ...built.record, command: fakeBuild(other) }));

    const failure = expectFailure(() => assertBuildRecordCurrent(other, fakeBuild(other)), "build-record-stale");
    expect(failure.message).toContain("app/auth/dev-login/route.ts");
  });
});
