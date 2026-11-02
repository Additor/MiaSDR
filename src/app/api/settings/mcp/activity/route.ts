import { listMcpToolCalls } from "@/contexts/tenancy/application/mcp-tool-calls";
import { mcpToolCallDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { withAdmin } from "@/app/_lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page of agent activity, newest first. `?reads=1` includes read calls; `?before=<call id>` pages back. */
export const GET = (request: Request) =>
  withAdmin("Only an owner or admin can see agent activity.", (actor) => {
    const params = new URL(request.url).searchParams;
    const before = params.get("before");
    return listMcpToolCalls(mcpToolCallDeps(), actor, { writesOnly: params.get("reads") !== "1", before: before && UUID.test(before) ? before : null });
  });
