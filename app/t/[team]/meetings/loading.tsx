import { MeetingDetailSkeleton } from "@/components/meetings/meeting-detail-skeleton";

/**
 * Right-pane fallback for the Meetings index (`/meetings`, which renders the newest note inline). The
 * shared `layout.tsx` already painted the list rail + header; this covers the detail pane while the
 * newest note's data streams in, so arriving at Meetings shows structure immediately rather than a
 * blank right pane. (`[id]/loading.tsx` covers the same pane when switching between meetings.)
 */
export default function MeetingsIndexLoading() {
  return <MeetingDetailSkeleton />;
}
