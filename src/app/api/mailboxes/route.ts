import { z } from "zod";
import { connectMailbox, listMailboxes } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor, withAdmin } from "@/shared/api";

export const GET = () => withActor((actor) => listMailboxes(mailboxDeps(), actor));

export const POST = (request: Request) =>
  withAdmin(
    "Only an owner or admin can manage mailboxes.",
    async (actor) => connectMailbox(mailboxDeps(), actor, z.object({ emailAddress: z.string(), displayName: z.string().max(100).optional() }).parse(await request.json())),
    201,
  );
