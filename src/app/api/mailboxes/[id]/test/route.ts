import { retestMailbox } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/mailboxes/[id]/test">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await retestMailbox(mailboxDeps(), actor, id);
    return { ok: true };
  });
}
