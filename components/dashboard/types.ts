/** Shared shapes for the dashboard data widgets. */

export interface DecisionRow {
  id: string;
  title: string;
  decided_at: string | null;
  tier: number | null;
  still_valid: boolean;
  /** The item (decision-log doc / meeting) this decision was recorded in — links to /library/<id>. */
  source_item_id: string | null;
}
