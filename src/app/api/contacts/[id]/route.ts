import { contactDeleteDeps } from "@/composition/person-lifecycle";
import { deleteContact } from "@/contexts/leads/application/contact-delete";
import { withActor } from "@/shared/api";

const COUNT_KEYS = ["deals", "notes", "tasks", "events", "conversations", "messages", "sends"] as const;

/**
 * Deletes a contact with no open deal. The query carries the counts the dialog showed (`?deals=&notes=&tasks=
 * &events=&conversations=&messages=&sends=`); a count that changed answers 409 `counts_changed` with the new counts. 200
 * `{ deleted: counts }`. A repeat after success answers 404, which the dialog reads as done.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/contacts/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const params = new URL(request.url).searchParams;
    const expected = Object.fromEntries(COUNT_KEYS.map((key) => [key, params.get(key) ?? undefined]));
    return deleteContact(contactDeleteDeps, actor, id, { expected });
  });
}
