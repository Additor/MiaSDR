import { makeContactDeps } from "@/composition/person-lifecycle";
import { makeContact } from "@/contexts/leads/application/make-contact";
import { withActor } from "@/app/_lib/api";

/**
 * Make contact: the lead becomes a contact without a deal. 200 `{ personId, stopped }`. A second call answers
 * 409 `already_converted`, which the dialog reads as done; 409 `personal_campaign` while another member's personal campaign
 * still reaches the person.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/leads/[id]/make-contact">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await request.json();
    return makeContact(makeContactDeps, actor, id);
  });
}
