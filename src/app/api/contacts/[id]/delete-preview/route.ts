import { contactDeleteDeps } from "@/composition/person-lifecycle";
import { previewContactDelete } from "@/contexts/leads/application/contact-delete";
import { withActor } from "@/shared/api";

/** What a delete of the contact removes and what blocks it, as the caller may see it. */
export async function GET(_request: Request, ctx: RouteContext<"/api/contacts/[id]/delete-preview">) {
  const { id } = await ctx.params;
  return withActor((actor) => previewContactDelete(contactDeleteDeps, actor, id));
}
