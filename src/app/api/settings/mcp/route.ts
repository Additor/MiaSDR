import { z } from "zod";
import { getMcpSettings, updateMcpSettings } from "@/contexts/tenancy/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

export const GET = () => withActor((actor) => getMcpSettings(mcpTokenDeps(), actor));

/** Takes `{ enabled }` for now; `updateMcpSettings` refuses the keys whose tools have not shipped. */
export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change MCP settings.", async (actor) => updateMcpSettings(mcpTokenDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json())));
