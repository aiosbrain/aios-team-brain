import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ClientConfig = {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
};

type LoadSchema = (options?: {
  cwd?: string;
  databaseUrl?: string;
  env?: Record<string, string | undefined>;
  createClient?: (config: ClientConfig) => FakeClient;
  logger?: { log: (message: string) => void };
}) => Promise<void>;

class FakeClient {
  connected = false;
  ended = false;
  queries: string[] = [];

  constructor(
    readonly config: ClientConfig,
    private readonly failOnQueryIndex: number | null = null
  ) {}

  async connect() {
    this.connected = true;
  }

  async query(sql: string) {
    if (this.failOnQueryIndex === this.queries.length) {
      throw new Error("query failed");
    }
    this.queries.push(sql);
  }

  async end() {
    this.ended = true;
  }
}

const tmpRoots: string[] = [];

async function importLoader() {
  return (await import("../scripts/pg-load-schema.mjs")) as {
    loadSchema: LoadSchema;
    shouldUseSsl: (databaseUrl: string, env?: Record<string, string | undefined>) => boolean;
  };
}

function makeWorkspace(migrations: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pg-load-schema-"));
  tmpRoots.push(root);
  const pgDir = path.join(root, "postgres");
  const migDir = path.join(pgDir, "migrations");
  mkdirSync(migDir, { recursive: true });
  writeFileSync(path.join(pgDir, "schema.sql"), "create table base();");
  for (const [file, sql] of Object.entries(migrations)) {
    writeFileSync(path.join(migDir, file), sql);
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpRoots.length > 0) {
    rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe("pg-load-schema", () => {
  it("runs schema.sql before SQL migrations in lexical order", async () => {
    const { loadSchema } = await importLoader();
    const root = makeWorkspace({
      "002_second.sql": "alter table base add column second text;",
      "notes.txt": "not sql",
      "001_first.sql": "alter table base add column first text;",
    });
    const clients: FakeClient[] = [];
    const log = vi.fn();

    await loadSchema({
      cwd: root,
      databaseUrl: "postgres://app:app@localhost:5432/app",
      createClient: (config) => {
        const client = new FakeClient(config);
        clients.push(client);
        return client;
      },
      logger: { log },
    });

    expect(clients).toHaveLength(1);
    expect(clients[0].queries).toEqual([
      "create table base();",
      "alter table base add column first text;",
      "alter table base add column second text;",
    ]);
    expect(clients[0].ended).toBe(true);
    expect(log.mock.calls.map(([message]) => message.replace(/^.\s/, ""))).toEqual([
      "postgres/schema.sql loaded",
      "postgres/migrations/001_first.sql applied",
      "postgres/migrations/002_second.sql applied",
    ]);
  });

  it("uses SSL only when the database URL or environment explicitly requires it", async () => {
    const { loadSchema, shouldUseSsl } = await importLoader();
    expect(shouldUseSsl("postgres://db/app?sslmode=require", {})).toBe(true);
    expect(shouldUseSsl("postgres://db/app", { PGSSL: "require" })).toBe(true);
    expect(shouldUseSsl("postgres://db/app", { PGSSLMODE: "require" })).toBe(true);
    expect(shouldUseSsl("postgres://db/app?sslmode=disable", {})).toBe(false);

    const root = makeWorkspace();
    const configs: ClientConfig[] = [];
    await loadSchema({
      cwd: root,
      databaseUrl: "postgres://db/app?sslmode=require",
      env: {},
      createClient: (config) => {
        configs.push(config);
        return new FakeClient(config);
      },
      logger: { log: vi.fn() },
    });

    expect(configs).toEqual([
      {
        connectionString: "postgres://db/app?sslmode=require",
        ssl: { rejectUnauthorized: false },
      },
    ]);
  });

  it("refuses to run without DATABASE_URL before touching the filesystem", async () => {
    const { loadSchema } = await importLoader();
    await expect(loadSchema({ databaseUrl: "" })).rejects.toThrow("DATABASE_URL is required");
  });

  it("closes the database connection when a migration query fails", async () => {
    const { loadSchema } = await importLoader();
    const root = makeWorkspace({
      "001_first.sql": "alter table base add column first text;",
    });
    const clients: FakeClient[] = [];

    await expect(
      loadSchema({
        cwd: root,
        databaseUrl: "postgres://app:app@localhost:5432/app",
        createClient: (config) => {
          const client = new FakeClient(config, 1);
          clients.push(client);
          return client;
        },
        logger: { log: vi.fn() },
      })
    ).rejects.toThrow("query failed");

    expect(clients).toHaveLength(1);
    expect(clients[0].queries).toEqual(["create table base();"]);
    expect(clients[0].ended).toBe(true);
  });
});
