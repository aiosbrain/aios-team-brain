import { governedActionHttp } from "@/lib/actions/governed/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  return governedActionHttp.submit(req);
}
