/** Shared shapes for the dashboard data widgets. */

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
