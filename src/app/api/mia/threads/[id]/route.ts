import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { deleteChat, openChat, renameChat } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";

const RENAME = z.object({ title: z.string().max(500) }).strict();

/** One of the person's chats with its messages. Another member's chat answers 404. */
export async function GET(_request: Request, ctx: RouteContext<"/api/mia/threads/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => openChat(miaChatDeps(), actor, id));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/mia/threads/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = RENAME.parse(await request.json());
    await renameChat(miaChatDeps(), actor, id, body.title);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/mia/threads/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await deleteChat(miaChatDeps(), actor, id);
    return { ok: true };
  });
}
