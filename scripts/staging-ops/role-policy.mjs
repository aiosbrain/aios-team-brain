const INTERNAL = /(?:^|\.)railway\.internal$/i;

function parseDbHost(raw, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} connection URL is invalid (value redacted)`); }
  if (!INTERNAL.test(url.hostname) || url.searchParams.has("routing") || url.hostname.includes(",")) throw new Error(`${label} must use one exact internal service hostname without routing aliases`);
  return url.hostname;
}

export function assertRunnerRole(env, role) {
  if (env.STAGING_OPS_ROLE !== role) throw new Error(`runner role must be exactly ${role}`);
  if (!/^sha256:[0-9a-f]{64}$/i.test(env.STAGING_OPS_IMAGE_DIGEST ?? "")) throw new Error("runner must declare a pinned immutable image digest");
  if (env.RAILWAY_SOURCE_BRANCH || env.RAILWAY_AUTODEPLOY === "true") throw new Error("ops runner must not have a branch source or ordinary autodeploy trigger");
  if (role === "exporter") {
    if (!env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_ID !== env.PRODUCTION_EXPORT_ENVIRONMENT_ID) throw new Error("exporter is not pinned to production environment identity");
    if (env.STAGING_DATABASE_URL || env.STAGING_NEO4J_URL) throw new Error("exporter must not receive staging database endpoints");
    parseDbHost(env.DATABASE_URL, "exporter Postgres"); parseDbHost(env.NEO4J_URL, "exporter Neo4j");
  } else {
    if (!env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_ID !== env.STAGING_OPS_ENVIRONMENT_ID) throw new Error("importer is not pinned to staging environment identity");
    if (env.PRODUCTION_DATABASE_URL || env.PRODUCTION_NEO4J_URL) throw new Error("importer must not receive production database endpoints");
    parseDbHost(env.DATABASE_URL, "importer Postgres"); parseDbHost(env.NEO4J_URL, "importer Neo4j");
  }
  return true;
}

export function assertOutboundCredentialIsolation(env) {
  const forbidden = ["RESEND_API_KEY", "SMTP_URL", "SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "SLACK_BOT_TOKEN", "GITHUB_TOKEN"];
  const present = forbidden.filter((name) => String(env[name] ?? "").trim());
  if (present.length) throw new Error(`ops runner inherited forbidden outbound/provider credentials: ${present.join(", ")}`);
}
