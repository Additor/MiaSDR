import { z } from "zod";
import { removeMailbox, updateMailbox } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor, withAdmin } from "@/app/_lib/api";

const window = z.object({ start: z.string(), end: z.string() });
const settings = z.object({
  displayName: z.string().max(100).nullable().optional(),
  dailySendLimit: z.number().optional(),
  signatureHtml: z.string().max(10000).nullable().optional(),
  workingHours: z.object({ timeZone: z.string(), days: z.record(z.string(), z.array(window)) }).nullable().optional(),
});

export async function PATCH(request: Request, ctx: RouteContext<"/api/mailboxes/[id]">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can manage mailboxes.", async (actor) => {
    await updateMailbox(mailboxDeps(), actor, id, settings.parse(await request.json()));
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/mailboxes/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await removeMailbox(mailboxDeps(), actor, id);
    return { ok: true };
  });
}
