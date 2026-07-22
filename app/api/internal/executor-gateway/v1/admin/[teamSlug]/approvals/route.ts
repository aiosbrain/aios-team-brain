import { gatewayAdminContext, adminFailure } from "@/lib/gateway/admin-http";
import { listGatewayApprovals } from "@/lib/gateway/admin-persistence";
import { gatewayDisabled, gatewayJson, isResponse } from "@/lib/gateway/http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ teamSlug: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const ctx = await gatewayAdminContext((await params).teamSlug);
  if (isResponse(ctx)) return ctx;
  try {
    return gatewayJson({ approvals: await listGatewayApprovals(ctx) });
  } catch (error) {
    return adminFailure(error);
  }
}
