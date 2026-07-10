import type { Metadata } from "next";
import { DataBrowser } from "@/components/library/data-browser";

export const metadata: Metadata = { title: "Data" };

/**
 * Admin → Data: the ingested-data channel browser. Moved here from the primary nav (2026-07-10) —
 * it's a verification/debug view, so it's now admin-gated by the Admin layout. The heavy lifting
 * lives in the shared `DataBrowser` server component; item detail stays at `/t/[team]/library/[id]`.
 */
export default async function AdminDataPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ channel?: string; limit?: string }>;
}) {
  const { team: teamSlug } = await params;
  const { channel, limit } = await searchParams;
  return (
    <DataBrowser
      teamSlug={teamSlug}
      basePath={`/t/${teamSlug}/admin/data`}
      channelParam={channel}
      limitParam={limit}
    />
  );
}
