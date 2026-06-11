import { Shield } from "lucide-react";
import { serverClient } from "@/lib/supabase/server";
import { AdminTabs } from "@/components/admin/admin-tabs";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ team: string }>;
}) {
  const { team: teamSlug } = await params;
  const supabase = await serverClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();

  const { data: me } = team
    ? await supabase
        .from("members")
        .select("role")
        .eq("team_id", team.id)
        .eq("auth_user_id", user?.id ?? "")
        .eq("status", "active")
        .maybeSingle()
    : { data: null };

  if (me?.role !== "admin") {
    return (
      <div className="mx-auto max-w-md pt-16">
        <div className="prism-card flex flex-col items-center gap-3 px-8 py-12 text-center">
          <Shield className="size-8 text-violet" strokeWidth={1.5} />
          <h1 className="text-xl font-semibold text-ink">Admins only</h1>
          <p className="text-sm text-ink-secondary">
            This area manages members, API keys and the audit trail. Ask a team admin if you need
            something changed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Admin</h1>
        <AdminTabs base={`/t/${teamSlug}/admin`} />
      </div>
      {children}
    </div>
  );
}
