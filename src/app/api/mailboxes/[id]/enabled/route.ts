import { z } from "zod";
import { setMailboxEnabled } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { withAdmin } from "@/shared/api";

export async function POST(request: Request, ctx: RouteContext<"/api/mailboxes/[id]/enabled">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can manage mailboxes.", async (actor) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await request.json());
    await setMailboxEnabled(mailboxDeps(), actor, id, enabled);
    return { ok: true };
  });
}
