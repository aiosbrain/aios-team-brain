import "server-only";
import neo4j, { type Driver } from "neo4j-driver";

/**
 * Read-only Neo4j client for the Graphiti graph. The "What the Brain is Learning" panel reads the
 * graph DIRECTLY (the getzep REST server only exposes /search + /episodes — not "recent typed facts
 * by time" or a windowed node/edge dump). This module owns nothing but the pooled driver + a read
 * helper; ALL Cypher lives in `lib/graph/learning`. See docs/design/brain-learning-panel.md.
 *
 * Best-effort: `neo4jConfigured()` is false unless `NEO4J_URL` is set; `runRead` throws on a
 * transport error so callers degrade (the panel shows empty rather than 500ing).
 *
 * Env: NEO4J_URL (bolt://host:7687) · NEO4J_USER (default 'neo4j') · NEO4J_PASSWORD.
 * ⚠️ Coupling: we depend on Graphiti's internal Neo4j schema — pin the zepai/graphiti image tag and
 * keep every query in `lib/graph/learning` so a schema change on upgrade is caught in one place.
 */

let driver: Driver | undefined;

export function neo4jConfigured(): boolean {
  return !!process.env.NEO4J_URL;
}

function getDriver(): Driver {
  if (driver) return driver;
  const url = process.env.NEO4J_URL;
  if (!url) throw new Error("NEO4J_URL is not set (Graphiti Neo4j read access is unconfigured)");
  driver = neo4j.driver(
    url,
    neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? ""),
    {
      maxConnectionPoolSize: Number(process.env.NEO4J_POOL_MAX ?? 10),
      connectionAcquisitionTimeout: 10_000,
    }
  );
  return driver;
}

/** Recursively normalize Neo4j values to plain JS: Integer → number, temporal → ISO string. */
function plain(v: unknown): unknown {
  if (v == null) return v;
  if (neo4j.isInt(v)) return v.toNumber();
  if (
    neo4j.isDateTime(v) ||
    neo4j.isDate(v) ||
    neo4j.isLocalDateTime(v) ||
    neo4j.isTime(v) ||
    neo4j.isLocalTime(v) ||
    neo4j.isDuration(v)
  ) {
    return v.toString();
  }
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = plain(val);
    return out;
  }
  return v;
}

/**
 * Run a read-only Cypher query; returns records as plain objects. Uses a READ session (routed to a
 * follower in a cluster). Throws on transport error — callers wrap best-effort.
 */
export async function runRead<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.executeRead((tx) => tx.run(cypher, params));
    return res.records.map((r) => plain(r.toObject()) as T);
  } finally {
    await session.close();
  }
}

/** Close the pooled driver (tests / graceful shutdown). */
export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
}
