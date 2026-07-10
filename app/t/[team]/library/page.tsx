import { redirect } from "next/navigation";

/**
 * The Data channel browser moved to Admin → Data (2026-07-10). This index route now redirects there,
 * preserving any `?channel=`/`?limit=` deep link. Item detail (`/library/[id]`) and skills
 * (`/library/skills`) stay put — they're linked from arc evidence, query citations, etc.
 */
export default async function LibraryIndexRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ channel?: string; limit?: string }>;
}) {
  const { team } = await params;
  const { channel, limit } = await searchParams;
  const qs = new URLSearchParams();
  if (channel) qs.set("channel", channel);
  if (limit) qs.set("limit", limit);
  const query = qs.toString();
  redirect(`/t/${team}/admin/data${query ? `?${query}` : ""}`);
}
