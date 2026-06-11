import { redirect } from "next/navigation";

export default async function AdminIndex({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  redirect(`/t/${team}/admin/members`);
}
