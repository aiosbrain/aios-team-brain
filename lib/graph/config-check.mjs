/**
 * The graph-store configuration diagnostic shared by `npm run doctor` and the boot hook
 * (`instrumentation.ts`), so the two cannot disagree about what a deploy will do.
 *
 * Plain ESM with no TypeScript, like `lib/db/pg/ssl.mjs`, so `node scripts/doctor.mjs` can import it
 * as-is; JSDoc carries the types for the TS app.
 *
 * The trap it names (AIO-1167): `GRAPHITI_URL` used to be the whole graph switch. Graph READS now go
 * directly to Neo4j so every fact's provenance can be checked against the reader, and they FAIL
 * CLOSED without `NEO4J_URL` — every graph-scoped query answers 503 from the first request after the
 * deploy. That is deliberate (README §2.8c) and this check does not change it: it only says so before
 * a reader finds out. Neither value is echoed — a bolt URL can carry credentials.
 *
 * The predicates mirror the runtime's exactly: `graphitiConfigured` (`lib/graph/graphiti-client.ts`)
 * for Graphiti and `neo4jConfigured` (`lib/graph/neo4j.ts`, any non-empty `NEO4J_URL`) for Neo4j.
 */

/** @param {string | undefined} url */
function graphitiConfigured(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ status: "ok" | "warn", detail: string, fix?: string }}
 */
export function checkGraphStores(env) {
  const graphiti = graphitiConfigured(env.GRAPHITI_URL);
  const neo4j = !!env.NEO4J_URL;
  if (graphiti && !neo4j) {
    return {
      status: "warn",
      detail:
        "GRAPHITI_URL is set without NEO4J_URL — every graph-scoped query (retrieval's graph leg, " +
        "/api/v1/query, the dashboard query, /api/v1/graph-query) fails closed with 503 until NEO4J_URL is set",
      fix: "set NEO4J_URL (and NEO4J_USER / NEO4J_PASSWORD) to the Neo4j that Graphiti writes — README §2.8c",
    };
  }
  if (env.GRAPHITI_URL && !graphiti) {
    return {
      status: "warn",
      detail: "GRAPHITI_URL is set but is not an http(s) URL — graph projection and graph retrieval are off",
      fix: "use the Graphiti service's http(s) URL, e.g. http://graphiti.railway.internal:8000",
    };
  }
  if (graphiti) return { status: "ok", detail: "Graphiti + Neo4j (provenance-checked graph reads)" };
  if (neo4j) return { status: "ok", detail: "Neo4j only (direct /api/v1/graph-query reads; projection off)" };
  return { status: "ok", detail: "not configured (graph memory off)" };
}
