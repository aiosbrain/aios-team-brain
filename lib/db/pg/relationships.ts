/**
 * Foreign-key registry for the bounded set of PostgREST embedded-resource
 * selects the app uses. PostgREST infers these from FKs; we declare them
 * explicitly so the adapter can compile `projects(slug)` / `items(count)` into
 * correlated subqueries with the exact JSON shape the call sites expect.
 *
 * kind:
 *   "one"   → to-one embed → JSON object or null, keyed by the embed name/alias
 *   "many"  → to-many embed → only used as `(count)` here → `[{ count: N }]`
 */

export interface Relationship {
  kind: "one" | "many";
  table: string;
  /** column on the BASE table */
  local: string;
  /** column on the RELATED table */
  foreign: string;
}

export const RELATIONSHIPS: Record<string, Record<string, Relationship>> = {
  items: {
    projects: { kind: "one", table: "projects", local: "project_id", foreign: "id" },
    members: { kind: "one", table: "members", local: "member_id", foreign: "id" },
    item_versions: { kind: "many", table: "item_versions", local: "id", foreign: "item_id" },
  },
  tasks: {
    projects: { kind: "one", table: "projects", local: "project_id", foreign: "id" },
    // alias `items:source_item_id(...)` → embed name "items", FK source_item_id
    items: { kind: "one", table: "items", local: "source_item_id", foreign: "id" },
  },
  decisions: {
    projects: { kind: "one", table: "projects", local: "project_id", foreign: "id" },
    // alias `items:source_item_id(...)` → embed name "items", FK source_item_id
    // (used by GET /api/v1/decisions writeback to read the source item's synced_at).
    items: { kind: "one", table: "items", local: "source_item_id", foreign: "id" },
  },
  api_keys: {
    members: { kind: "one", table: "members", local: "member_id", foreign: "id" },
    teams: { kind: "one", table: "teams", local: "team_id", foreign: "id" },
  },
  members: {
    teams: { kind: "one", table: "teams", local: "team_id", foreign: "id" },
  },
  projects: {
    items: { kind: "many", table: "items", local: "id", foreign: "project_id" },
    tasks: { kind: "many", table: "tasks", local: "id", foreign: "project_id" },
  },
  code_contributions: {
    // member profile aggregates a contributor's work across codebases by slug.
    codebases: { kind: "one", table: "codebases", local: "codebase_id", foreign: "id" },
  },
};

export function lookupRelationship(base: string, name: string): Relationship | undefined {
  return RELATIONSHIPS[base]?.[name];
}
