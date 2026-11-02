import { connection } from "next/server";
import { apiError } from "@/app/_lib/api-errors";
import { mcpOAuthAvailable } from "@/contexts/identity/domain/mcp-oauth";
import { authServerMetadata } from "@/contexts/identity/infrastructure/mcp-oauth";
import { env } from "@/shared/env";

/** RFC 8414, at the path its issuer `<APP_URL>/api/auth` names. */
export async function GET(request: Request) {
  await connection();
  const { APP_URL, MCP_ENABLED } = env();
  if (!mcpOAuthAvailable(APP_URL, MCP_ENABLED)) return apiError(404, "Not found");
  return authServerMetadata(request);
}
