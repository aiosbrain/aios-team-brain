import { stagingBuildMetadataResponse } from "@/lib/staging/build-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return stagingBuildMetadataResponse(request);
}
