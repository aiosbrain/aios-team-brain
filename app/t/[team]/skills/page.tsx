import { redirect } from "next/navigation";

// Skills moved under Library (grouped IA). Preserve old links/bookmarks.
export default async function SkillsRedirect({
  params,
}: {
  params: Promise<{ team: string }>;
}) {
  const { team } = await params;
  redirect(`/t/${team}/library/skills`);
}
