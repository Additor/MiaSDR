import { z } from "zod";
import {
  archiveCustomColumn,
  deleteCustomColumn,
  renameCustomColumn,
  restoreCustomColumn,
} from "@/contexts/leads/application/custom-columns";
import { customColumnStore } from "@/contexts/leads/infrastructure/composition";
import { withAdmin } from "@/shared/api";

const DENIED = "Only an owner or admin can manage custom fields.";
const patch = z.object({ name: z.string().max(200).optional(), archived: z.boolean().optional() });

/** Rename with `name`, archive or restore with `archived`. Both in one call rename first. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/leads/columns/[id]">) {
  const { id } = await ctx.params;
  return withAdmin(DENIED, async (actor) => {
    const body = patch.parse(await request.json());
    if (body.name !== undefined) await renameCustomColumn(customColumnStore, actor, id, body.name);
    if (body.archived === true) await archiveCustomColumn(customColumnStore, actor, id);
    if (body.archived === false) await restoreCustomColumn(customColumnStore, actor, id);
    return { ok: true };
  });
}

/** Permanent. The column must be archived; its values leave every row. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/leads/columns/[id]">) {
  const { id } = await ctx.params;
  return withAdmin(DENIED, async (actor) => ({ ok: true, ...(await deleteCustomColumn(customColumnStore, actor, id)) }));
}
