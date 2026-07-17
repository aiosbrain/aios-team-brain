/**
 * Instant navigation feedback for every `/t/[team]/*` tab. `/t/[team]` is a dynamic route, so
 * without a `loading.tsx` a click waits on the full server render before anything paints — which
 * reads as "the app froze" (see the Next.js "dynamic routes without loading.tsx" guidance). Next
 * wraps each page in a Suspense boundary with this as the prefetched fallback, so the sidebar stays
 * put and interactive while the content area shows this skeleton the instant a tab is clicked.
 *
 * Deliberately generic (title + KPI row + card grid) — it stands in for any surface without
 * pretending to know its exact shape; the goal is immediate "something is loading," not a
 * pixel-match of the destination.
 */
function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface-inset ${className}`} />;
}

export default function TeamSectionLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6" aria-busy="true" aria-label="Loading">
      {/* header */}
      <div className="flex flex-col gap-2">
        <Shimmer className="h-7 w-48" />
        <Shimmer className="h-4 w-80 max-w-full" />
      </div>

      {/* KPI-ish row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="prism-card flex flex-col gap-3 px-5 py-5">
            <Shimmer className="h-3 w-20" />
            <Shimmer className="h-6 w-16" />
          </div>
        ))}
      </div>

      {/* content cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="prism-card flex flex-col gap-3 px-5 py-5">
            <Shimmer className="h-5 w-2/3" />
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-5/6" />
            <div className="mt-2 flex items-center gap-2">
              <Shimmer className="size-6 rounded-full" />
              <Shimmer className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
