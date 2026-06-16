/** Shared shapes for the dashboard data widgets. */

export interface ActivityItem {
  id: string;
  path: string;
  kind: string;
  actor: string;
  synced_at: string;
  projects: { slug: string } | null;
}

export interface CommitmentRow {
  id: string;
  entity_id: string;
  name: string;
  attrs: Record<string, unknown>;
}

export interface TaskRow {
  id: string;
  title: string;
  assignee: string;
  status: string;
}

export interface DecisionRow {
  id: string;
  title: string;
  decided_at: string | null;
  tier: number | null;
  still_valid: boolean;
}
