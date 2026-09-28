import { healthResponse } from "@/lib/health/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  return healthResponse();
}
