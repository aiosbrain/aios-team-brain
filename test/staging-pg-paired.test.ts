import { describe, expect, it, vi } from "vitest";
import { capturePairedPostgres, restorePairedPostgres } from "../scripts/staging-ops/pg-paired.mjs";

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

  it("restores pre-data, retained data, projected auth, post-data in order before loader", async () => {
    const execImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ held: false }] }), on: vi.fn() };
    await expect(restorePairedPostgres({ client, databaseUrl: "postgres://target/db", directory: "/tmp", execImpl })).rejects.toThrow(/exclusive data-use lock/);
    expect(execImpl.mock.calls.slice(0, 5).map(([, args]) => args.join(" "))).toEqual([
      expect.stringContaining("--section=pre-data"), expect.stringContaining("--section=data"),
      expect.stringContaining("\\copy public.auth_users"), expect.stringContaining("\\copy public.graph_episodes"), expect.stringContaining("--section=post-data"),
    ]);
  });
});
