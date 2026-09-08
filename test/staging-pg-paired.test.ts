import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePairedPostgres, restorePairedPostgres } from "../scripts/staging-ops/pg-paired.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("section-wise paired Postgres capture/install", () => {
  it("holds one exported snapshot across dump and transformed auth projection", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ snapshot: "00000003-0000001B-1" }] })
      .mockResolvedValueOnce({ rows: [{ column_name: "id" }, { column_name: "email" }, { column_name: "password_hash" }] })
      .mockResolvedValueOnce({ rows: [{ column_name: "id" }, { column_name: "pending_delete_group_id" }, { column_name: "pending_delete_at" }] })
      .mockResolvedValueOnce({ rows: [] });
    const execImpl = vi.fn().mockResolvedValue({ stdout: "id,email,password_hash\n1,a@example.test,\n", stderr: "" });
    await capturePairedPostgres({ client: { query }, databaseUrl: "postgres://source/db", directory: "/tmp", execImpl });
    const calls = execImpl.mock.calls.map(([, args]) => args.join(" "));
    expect(calls[0]).toContain("--snapshot=00000003-0000001B-1");
    expect(calls[0]).toContain("--exclude-table-data=auth_users");
    expect(calls[1]).toContain('NULL::text AS "password_hash"');
    expect(calls[2]).toContain('NULL::text AS "pending_delete_group_id"');
    expect(query.mock.calls.at(-1)[0]).toBe("COMMIT");
  });

  it("lists, cleans, then restores pre-data, retained data, projected auth, post-data before loader", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "staging-restore-"));
    roots.push(directory);
    const execImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    // Every enumeration answers empty, so the cleanup is a no-op and the ORDER is what is pinned.
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), on: vi.fn() };
    await expect(restorePairedPostgres({ client, databaseUrl: "postgres://target/db", directory, execImpl, env: { STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } }))
      .rejects.toThrow(/exclusive data-use lock/);

    const commands = execImpl.mock.calls.map(([, args]) => args.join(" "));
    expect(commands[0]).toContain("--list");
    expect(commands.slice(1, 6)).toEqual([
      expect.stringContaining("--section=pre-data"), expect.stringContaining("--section=data"),
      expect.stringContaining("\\copy public.auth_users"), expect.stringContaining("\\copy public.graph_episodes"),
      expect.stringContaining("--section=post-data"),
    ]);
    // The replay is driven by the FILTERED list, never the raw archive TOC.
    for (const command of commands.slice(1, 6).filter((c) => c.includes("--section="))) {
      expect(command).toContain("--use-list=");
    }
    // `--clean` is gone: FK drops live in post-data, so a pre-data clean left them behind and the
    // replay failed on dependency errors. The explicit enumerate-and-drop replaces it.
    expect(commands.join(" ")).not.toContain("--clean");

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    // The transaction reset comes FIRST — before the marker read, which is the statement a real
    // PG18 run was measured failing on with 25P02 after an aborted transactional migration. The
    // cleanup then resets again and discards this session's temp objects before its own BEGIN.
    expect(statements[0]).toBe("ROLLBACK");
    expect(statements[1]).toContain("to_regclass");
    expect(statements.slice(2, 5)).toEqual(["ROLLBACK", "DISCARD TEMP", "BEGIN"]);
    expect(statements).toContain("COMMIT");
    // Neither reset may be widened into something that drops the fence's session state.
    expect(statements).not.toContain("DISCARD ALL");
  });

  it("refuses to restore through a session whose transaction state cannot be reset", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "staging-restore-dead-"));
    roots.push(directory);
    const execImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    // A connection that cannot even ROLLBACK is unusable; reading the marker through it would
    // produce a 25P02 whose message says nothing about what actually went wrong.
    const client = {
      query: vi.fn(async (sql: string) => {
        if (String(sql) === "ROLLBACK") throw new Error("Connection terminated unexpectedly");
        return { rows: [] };
      }),
      on: vi.fn(),
    };
    await expect(restorePairedPostgres({ client, databaseUrl: "postgres://target/db", directory, execImpl, env: { STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } }))
      .rejects.toThrow(/could not be reset before reading the staging marker/);
    // Nothing destructive was attempted, and no restore command ran.
    expect(client.query.mock.calls.map(([sql]) => String(sql))).toEqual(["ROLLBACK"]);
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("omits the public schema and the preserved marker from the replay list", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "staging-restore-list-"));
    roots.push(directory);
    const listing = [
      "5; 2615 2200 SCHEMA - public postgres",
      "215; 1259 16388 TABLE public items postgres",
      "216; 1259 16400 TABLE public staging_marker postgres",
    ].join("\n");
    const execImpl = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes("--list") ? { stdout: listing, stderr: "" } : { stdout: "", stderr: "" });
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), on: vi.fn() };
    await expect(restorePairedPostgres({ client, databaseUrl: "postgres://target/db", directory, execImpl, env: { STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } }))
      .rejects.toThrow(/exclusive data-use lock/);
    const written = readFileSync(path.join(directory, "restore.list"), "utf8");
    expect(written).toContain("TABLE public items postgres");
    expect(written).not.toContain("SCHEMA - public");
    expect(written).not.toContain("staging_marker");
  });
});
