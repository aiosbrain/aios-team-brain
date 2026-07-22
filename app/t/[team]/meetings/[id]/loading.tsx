import { MeetingDetailSkeleton } from "@/components/meetings/meeting-detail-skeleton";

/**
 * Instant right-pane feedback when switching meetings. The Meetings `layout.tsx` (list rail + header)
 * is shared and preserved across `/meetings/[id]` navigations, so Next resets only THIS segment's
 * Suspense boundary when the id changes — showing this skeleton in the right pane immediately while
 * the selected note's summary/transcript/action-items stream in. Without it, clicking a meeting left
 * the previous note (or a blank pane) on screen until the fetch finished.
 */
export default function MeetingDetailLoading() {
  return <MeetingDetailSkeleton />;
}
