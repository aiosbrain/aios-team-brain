"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RANGES, type Range } from "@/lib/metrics/range";

const LABELS: Record<Range, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };

export function RangeSelector({ value }: { value: Range }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(range: Range) {
    const params = new URLSearchParams(searchParams);
    params.set("range", range);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="inline-flex items-center rounded-lg border border-border-subtle bg-surface-inset p-0.5">
      {RANGES.map((range) => {
        const active = range === value;
        return (
          <button
            key={range}
            type="button"
            onClick={() => select(range)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-violet/10 text-violet"
                : "text-ink-tertiary hover:text-ink-secondary"
            }`}
            aria-pressed={active}
          >
            {LABELS[range]}
          </button>
        );
      })}
    </div>
  );
}
