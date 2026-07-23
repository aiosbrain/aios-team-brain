import { redirect } from "next/navigation";

/**
 * The old "Learning" surface was absorbed into the team "Pulse" home (arcs hero + working-on +
 * Timeline + the Evidence-trail facts/events disclosures), so this route now redirects there. `redirect()`
 * issues a 307 (temporary) — deliberately not `permanentRedirect()`, so bookmarks/deep links keep working
 * without a cached 308 pinning the IA if it moves again.
 */
export default async function LearningRedirect({ params }: { params: Promise<{ team: string }> }) {
  const { team: teamSlug } = await params;
  redirect(`/t/${teamSlug}`);
}
