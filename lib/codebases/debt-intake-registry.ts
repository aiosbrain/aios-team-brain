import "server-only";

/** Reviewed server configuration, never populated from incoming finding records. */
export type IntakeRegistry = {
  producers: Record<string, readonly string[]>;
  codebases: readonly string[];
  linear_teams: readonly string[];
  uploaders: Record<string, Record<string, readonly string[]>>;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
function versions(value: unknown): value is Record<string, string[]> {
  return object(value) && Object.values(value).every(strings);
}

/** Missing or malformed reviewed configuration denies ingestion, including replay. */
export function intakeRegistry(teamId: string): IntakeRegistry | null {
  try {
    const config: unknown = JSON.parse(process.env.DEBT_INTAKE_REGISTRY_JSON ?? "{}");
    if (!object(config) || !Object.hasOwn(config, teamId)) return null;
    const team = config[teamId];
    if (!object(team) || !versions(team.producers) || !strings(team.codebases)
      || !strings(team.linear_teams) || !object(team.uploaders)
      || !Object.values(team.uploaders).every(versions)) return null;
    return team as IntakeRegistry;
  } catch {
    return null;
  }
}
