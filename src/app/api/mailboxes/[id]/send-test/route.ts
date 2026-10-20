import { z } from "zod";
import { sendTestEmail } from "@/contexts/outreach/email/application/send-test-email";
import { testSendDeps } from "@/contexts/outreach/infrastructure/composition";
import { withAdmin } from "@/shared/api";

const bodySchema = z.object({ to: z.string().min(3).max(320) }).strict();

/** Sends one test email through the send claim. The body is `{ to }`; the answer carries a `status` and a message to show. */
export async function POST(request: Request, ctx: RouteContext<"/api/mailboxes/[id]/send-test">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can send a test email.", async (actor) =>
    sendTestEmail(testSendDeps(), actor, id, bodySchema.parse(await request.json())),
  );
}
