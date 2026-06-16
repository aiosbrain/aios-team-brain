import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";

export default async function Home() {
  const supabase = await serverClient();
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("members")
    .select("team_id, created_at, teams(slug)")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1);

  const team = memberships?.[0]?.teams as unknown as { slug: string } | null;
  if (team?.slug) redirect(`/t/${team.slug}`);
  redirect("/login");
}
