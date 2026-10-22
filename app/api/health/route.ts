import { healthResponse } from "@/lib/staging/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return healthResponse(request);
}
