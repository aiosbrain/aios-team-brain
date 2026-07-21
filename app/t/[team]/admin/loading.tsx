/**
 * Instant feedback when switching admin tabs. The admin area is a shared layout (`admin/layout.tsx`)
 * with the tab bar + `{children}`; each tab is its own server-rendered route that runs several DB
 * queries before it can paint. Without a `loading.tsx` at this level, a tab click either waited on
 * the full render or fell back to the page-level skeleton (which would blank the tabs too). This
 * boundary sits *below* the tab bar, so the tabs stay put and interactive while the content area
 * shows a table/panel skeleton the instant a tab is clicked.
 */
function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-inset ${className}`} />;
}

export default function AdminTabLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      {/* an intro line most admin tabs render */}
      <Bar className="h-4 w-72 max-w-full" />

      {/* table/panel skeleton — admin surfaces are mostly rows of records */}
      <div className="prism-card flex flex-col overflow-hidden">
        <div className="flex items-center gap-4 border-b border-border-subtle px-4 py-3">
          <Bar className="h-3 w-24" />
          <Bar className="h-3 w-20" />
          <Bar className="ml-auto h-3 w-16" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border-subtle px-4 py-4 last:border-0">
            <Bar className="size-8 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Bar className="h-3.5 w-1/3" />
              <Bar className="h-3 w-1/4" />
            </div>
            <Bar className="h-7 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
