import { adminFailure, gatewayAdminContext } from "@/lib/gateway/admin-http";
import {
  createGatewayAdminPolicy,
  listGatewayAdminPolicies,
} from "@/lib/gateway/admin-persistence";
import { parseGatewayPolicyInput } from "@/lib/gateway/admin-validation";
import {
  gatewayDisabled,
  gatewayError,
  gatewayJson,
  isResponse,
  readGatewayJson,
} from "@/lib/gateway/http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ teamSlug: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const ctx = await gatewayAdminContext((await params).teamSlug);
  if (isResponse(ctx)) return ctx;
  try {
    return gatewayJson({ policies: await listGatewayAdminPolicies(ctx) });
  } catch (error) {
    return adminFailure(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ teamSlug: string }> },
) {
  const disabled = gatewayDisabled();
  if (disabled) return disabled;
  const ctx = await gatewayAdminContext((await params).teamSlug);
  if (isResponse(ctx)) return ctx;
  const body = await readGatewayJson(req);
  if (isResponse(body)) return body;
  const input = parseGatewayPolicyInput(body);
  if (!input) return gatewayError("gateway_invalid_request", 400);
  try {
    return gatewayJson(await createGatewayAdminPolicy(ctx, input), 201);
  } catch (error) {
    return adminFailure(error, input.correlationId);
  }
}
