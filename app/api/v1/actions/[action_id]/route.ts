import { governedActionHttp } from "@/lib/actions/governed/http";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ action_id: string }> },
) {
  return governedActionHttp.status(req, (await params).action_id);
}
