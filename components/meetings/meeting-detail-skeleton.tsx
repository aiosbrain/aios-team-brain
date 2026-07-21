/**
 * Right-pane skeleton for a meeting's detail (`MeetingDetailView`). The Meetings shell is a two-pane
 * layout whose async `layout.tsx` fetches the note list ONCE and is preserved across navigation — so
 * clicking a different meeting only re-renders the right pane (`children`). Without a loading boundary
 * below that shared layout, the right pane sat on the old note (or blank) until the new note's
 * summary/transcript/action-items finished loading, which reads as "the app is slow." This stands in
 * for the detail the instant a meeting is clicked; the real content swaps in when it streams.
 *
 * Mirrors the detail layout — title + meta, the Summary/Transcript tab bar, a bulleted summary, and
 * the action-items card — closely enough to avoid a jarring reflow, without pretending to know the
 * exact copy. Used by both meetings `loading.tsx` files (index + `[id]`).
 */
function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface-inset ${className}`} />;
}

export function MeetingDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading meeting">
      {/* header: title + meta line + attendee chips */}
      <div className="flex flex-col gap-2">
        <Shimmer className="h-7 w-2/3 max-w-sm" />
        <div className="flex items-center gap-3">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="size-4 rounded-full" />
          <Shimmer className="h-3 w-40" />
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Shimmer key={i} className="h-6 w-24 rounded-full" />
          ))}
        </div>
      </div>

      {/* tab bar: Summary / Transcript */}
      <div className="flex gap-4 border-b border-border-subtle pb-2">
        <Shimmer className="h-5 w-20" />
        <Shimmer className="h-5 w-24" />
      </div>

      {/* summary card (bullets live inside a prism-card, like the real Summary tab) */}
      <div className="prism-card flex flex-col gap-3 px-5 py-4">
        <Shimmer className="h-3 w-24" />
        {["w-11/12", "w-10/12", "w-full", "w-9/12", "w-10/12"].map((w, i) => (
          <div key={i} className="flex items-start gap-2">
            <Shimmer className="mt-1.5 size-1.5 shrink-0 rounded-full" />
            <Shimmer className={`h-4 ${w}`} />
          </div>
        ))}
      </div>

      {/* action-items card */}
      <div className="prism-card flex flex-col gap-3 px-5 py-5">
        <Shimmer className="h-4 w-32" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Shimmer className="size-4 rounded" />
            <Shimmer className="h-4 flex-1" />
            <Shimmer className="h-6 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
