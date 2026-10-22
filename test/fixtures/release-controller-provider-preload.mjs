import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const candidate = "b".repeat(40);
const main = "a".repeat(40);
const tagObject = "c".repeat(40);
const eventFile = process.env.RELEASE_FIXTURE_EVENTS;
const record = (event) => eventFile && appendFileSync(eventFile, `${JSON.stringify(event)}\n`);

childProcess.execFileSync = (...args) => {
  record({ type: "candidate-cli-subprocess", file: String(args[0]) });
  throw new Error("release candidate CLI subprocess was reached from the controller import");
};
syncBuiltinESMExports();

const json = (body, status = 200) => Response.json(body, { status });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = String(init.method ?? "GET");
  const body = init.body ? JSON.parse(String(init.body)) : null;
  record({ type: "fetch", method, url });

  if (url === "https://backboard.railway.com/graphql/v2") {
    if (String(body?.query).includes("StagingCandidateDeployment")) {
      return json({ data: { deployment: {
        id: "staging-dep", status: "SUCCESS", staticUrl: "staging.example.test",
        environmentId: "staging-env", serviceId: "staging-app", meta: { commitHash: candidate },
      } } });
    }
    return json({ data: { deployments: { edges: [{ node: {
      id: "production-dep", status: "SUCCESS", staticUrl: "production.example.test",
      environmentId: "production-env", serviceId: "production-app", meta: { commitHash: candidate },
    } }] } } });
  }

  if (url === "https://staging.example.test/api/health") {
    return json({ ok: true, commit: candidate, mode: "copy-ready", refreshRunId: "refresh-1" });
  }
  if (url === "https://production.example.test/api/health") {
    return json({ ok: true, commit: candidate });
  }
  if (url.includes("/app/installations/") && url.endsWith("/access_tokens")) return json({ token: "fixture-app-token" });
  if (url.includes("/git/ref/tags/")) return json({ object: { type: "tag", sha: tagObject } });
  if (url.includes(`/git/tags/${tagObject}`)) return json({ object: { type: "commit", sha: candidate } });
  if (url.includes("/contents/package.json")) {
    return json({ encoding: "base64", content: Buffer.from(JSON.stringify({ version: "1.2.3" })).toString("base64") });
  }
  if (url.includes(`/commits/${candidate}/check-runs`)) {
    const producerIds = JSON.parse(process.env.RELEASE_PRODUCER_IDS_JSON ?? "{}");
    return json({ check_runs: Object.entries(producerIds).map(([name, id]) => ({
      name, status: "completed", conclusion: "success", app: { id },
    })) });
  }
  if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: main } });
  if (url.includes("/compare/")) return json({ status: "ahead", base_commit: { sha: main } });
  if (method === "POST" && url.endsWith("/check-runs")) return json({ id: 7 });
  if (method === "PATCH" && url.endsWith("/git/refs/heads/main")) return json({ object: { sha: candidate } });
  throw new Error(`unhandled release-controller fixture request: ${method} ${url}`);
};
