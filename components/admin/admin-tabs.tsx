"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { slug: "members", label: "Members" },
  { slug: "keys", label: "API keys" },
  { slug: "audit", label: "Audit log" },
];

export function AdminTabs({ base }: { base: string }) {
  const pathname = usePathname();

  return (
    <div className="mt-3 flex gap-1 border-b border-border-subtle">
      {TABS.map((tab) => {
        const href = `${base}/${tab.slug}`;
        const active = pathname.startsWith(href);
        return (
          <Link
            key={tab.slug}
            href={href}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-violet text-violet"
                : "border-transparent text-ink-tertiary hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
