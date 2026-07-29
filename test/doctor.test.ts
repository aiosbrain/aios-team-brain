// Spec: `npm run doctor` must catch the setup mistakes that are otherwise SILENT —
// the ones README §5 exists to explain after the fact. Each assertion below is written
// from the intended guarantee ("a bad SECRETS_KEY must not reach a connector save"),
// not from what the implementation currently does.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  FAIL,
  OK,
  WARN,
  checkAppUrl,
  checkAuthSecret,
  checkDatabaseUrl,
  checkEmbeddings,
  checkMailer,
  checkModelProvider,
  checkNode,
  checkPgSsl,
  checkSecretsKey,
  parseEnvFile,
  summarize,
} from "../scripts/doctor.mjs";

describe("parseEnvFile", () => {
  it("agrees with `sh` on the forms .env.local actually uses", () => {
    const env = parseEnvFile(
      ["# comment", "", "DATABASE_URL=postgres://a:b@h:5432/d", "export AUTH_SECRET=abc", 'RESEND_FROM="AIOS <n@x.com>"', "EMPTY="].join("\n")
    );
    expect(env.DATABASE_URL).toBe("postgres://a:b@h:5432/d");
    expect(env.AUTH_SECRET).toBe("abc"); // `export ` prefix stripped
    expect(env.RESEND_FROM).toBe("AIOS <n@x.com>"); // quotes stripped, spaces kept
    expect(env.EMPTY).toBe("");
  });

  it("ignores malformed lines instead of throwing — doctor must survive the file it diagnoses", () => {
    expect(() => parseEnvFile("this is not an assignment\n=novalue")).not.toThrow();
    expect(parseEnvFile("garbage")).toEqual({});
  });
});

describe("SECRETS_KEY — must decode to exactly 32 bytes", () => {
  it("accepts a real 32-byte base64 key", () => {
    expect(checkSecretsKey(randomBytes(32).toString("base64")).status).toBe(OK);
  });

  it("FAILS the hex-instead-of-base64 mistake, and says so", () => {
    // 64 hex chars is what the AUTH_SECRET one-liner produces; pasted here it decodes
    // to 48 bytes and would throw only at the first connector save.
    const hex = randomBytes(32).toString("hex");
    const r = checkSecretsKey(hex);
    expect(r.status).toBe(FAIL);
    expect(r.fix).toMatch(/base64/i);
  });

  it("FAILS a wrong-width key rather than deferring the error to a 500", () => {
    expect(checkSecretsKey(randomBytes(16).toString("base64")).status).toBe(FAIL);
  });

  it("warns (not fails) when unset — connectors are optional, the rest of the app works", () => {
    expect(checkSecretsKey("").status).toBe(WARN);
  });
});

describe("APP_URL — an unset value silently breaks everyone's login link", () => {
  it("fails when missing", () => {
    expect(checkAppUrl("").status).toBe(FAIL);
  });

  it("fails a relative or scheme-less value", () => {
    expect(checkAppUrl("your-brain.up.railway.app").status).toBe(FAIL);
  });

  it("accepts an absolute http(s) URL", () => {
    expect(checkAppUrl("https://aios-acme.up.railway.app").status).toBe(OK);
  });
});

describe("AUTH_SECRET", () => {
  it("enforces the >=16 char minimum", () => {
    expect(checkAuthSecret("short").status).toBe(FAIL);
    expect(checkAuthSecret(randomBytes(32).toString("hex")).status).toBe(OK);
  });
});

describe("DATABASE_URL", () => {
  it("fails when unset or not a postgres URL", () => {
    expect(checkDatabaseUrl("").status).toBe(FAIL);
    expect(checkDatabaseUrl("mysql://a@b/c").status).toBe(FAIL);
  });

  it("accepts postgres:// and postgresql://", () => {
    expect(checkDatabaseUrl("postgres://app:app@localhost:5432/app").status).toBe(OK);
    expect(checkDatabaseUrl("postgresql://app:app@h/app").status).toBe(OK);
  });
});

describe("postgres TLS", () => {
  it("warns on a remote database with no TLS — managed providers reject it", () => {
    expect(checkPgSsl({ DATABASE_URL: "postgres://u:p@db.railway.app:5432/rw" }).status).toBe(WARN);
  });

  it("is satisfied by PGSSL=require or sslmode in the URL", () => {
    expect(checkPgSsl({ DATABASE_URL: "postgres://u:p@db.railway.app:5432/rw", PGSSL: "require" }).status).toBe(OK);
    expect(checkPgSsl({ DATABASE_URL: "postgres://u:p@db.railway.app:5432/rw?sslmode=require" }).status).toBe(OK);
  });

  it("does not nag about a local database", () => {
    expect(checkPgSsl({ DATABASE_URL: "postgres://app:app@localhost:5432/app" }).status).toBe(OK);
    expect(checkPgSsl({ DATABASE_URL: "postgres://app:app@postgres:5432/app" }).status).toBe(OK);
  });
});

describe("model provider — one text-generation path must resolve", () => {
  it("accepts either a cloud key or a local endpoint", () => {
    expect(checkModelProvider({ ANTHROPIC_API_KEY: "sk-ant-x" }).status).toBe(OK);
    expect(checkModelProvider({ LLM_BASE_URL: "http://localhost:11434/v1" }).status).toBe(OK);
  });

  it("warns rather than fails with neither — a provider can still be set per-team in Admin", () => {
    expect(checkModelProvider({}).status).toBe(WARN);
  });
});

describe("mail transport", () => {
  it("FAILS in production with no transport — magic links are dropped silently", () => {
    expect(checkMailer({}, "production").status).toBe(FAIL);
  });

  it("only warns outside production, where links print to the console", () => {
    expect(checkMailer({}, "development").status).toBe(WARN);
  });

  it("flags a Resend key with no from-address", () => {
    expect(checkMailer({ RESEND_API_KEY: "re_x" }, "production").status).toBe(WARN);
    expect(checkMailer({ RESEND_API_KEY: "re_x", RESEND_FROM: "AIOS <n@x.com>" }, "production").status).toBe(OK);
  });

  it("accepts SMTP as the fallback transport", () => {
    expect(checkMailer({ SMTP_URL: "smtp://u:p@h:587" }, "production").status).toBe(OK);
  });
});

describe("embeddings width — a mismatch degrades silently at query time", () => {
  it("is quiet when embeddings are not configured at all", () => {
    expect(checkEmbeddings({}).status).toBe(OK);
  });

  it("warns when EMBEDDINGS_DIM does not match the shipped vector(1536) column", () => {
    const r = checkEmbeddings({ EMBEDDINGS_URL: "https://api.openai.com/v1", EMBEDDINGS_DIM: "768" });
    expect(r.status).toBe(WARN);
    expect(r.fix).toMatch(/pgvector\.sql/);
  });

  it("accepts a configured backend at the shipped width", () => {
    expect(checkEmbeddings({ EMBEDDINGS_URL: "https://api.openai.com/v1", EMBEDDINGS_DIM: "1536" }).status).toBe(OK);
  });
});

describe("node runtime", () => {
  it("requires >=20 per package.json engines", () => {
    expect(checkNode("18.19.0").status).toBe(FAIL);
    expect(checkNode("20.11.0").status).toBe(OK);
    expect(checkNode("22.3.0").status).toBe(OK);
  });
});

describe("summarize", () => {
  it("exits non-zero only on failures, so warnings never block a valid install", () => {
    expect(summarize([{ status: OK }, { status: WARN }]).exitCode).toBe(0);
    expect(summarize([{ status: OK }, { status: FAIL }]).exitCode).toBe(1);
  });
});
