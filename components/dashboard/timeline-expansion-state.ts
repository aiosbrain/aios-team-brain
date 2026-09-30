import type { TimelineDay } from "@/lib/dashboard/timeline-group";

export interface TimelineExpansionState {
  days: TimelineDay[];
  windowDays: number;
  loading: boolean;
  failed: boolean;
  activeRequestId: number | null;
}

export type TimelineExpansionAction =
  | { type: "start"; requestId: number }
  | { type: "success"; requestId: number; days: TimelineDay[]; windowDays: number }
  | { type: "failure"; requestId: number };

/** The expanded API payload is a full snapshot, including any changes to days already displayed. */
export function timelineExpansionReducer(
  state: TimelineExpansionState,
  action: TimelineExpansionAction
): TimelineExpansionState {
  if (action.type === "start") {
    if (state.loading) return state;
    return { ...state, loading: true, failed: false, activeRequestId: action.requestId };
  }
  if (action.requestId !== state.activeRequestId) return state;
  if (action.type === "failure") {
    return { ...state, loading: false, failed: true, activeRequestId: null };
  }
  return {
    days: action.days,
    windowDays: action.windowDays,
    loading: false,
    failed: false,
    activeRequestId: null,
  };
}
