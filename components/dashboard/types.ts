/** Shared shapes for the dashboard data widgets. */

export interface DecisionRow {
  id: string;
  title: string;
  decided_at: string | null;
  tier: number | null;
  still_valid: boolean;
}
