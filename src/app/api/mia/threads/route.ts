import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { listChats, newChat } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";

const NEW_CHAT = z.object({ personId: z.string().max(64).nullable().optional() }).strict();

/** The signed-in person's own chats, newest first. */
export const GET = () => withActor((actor) => listChats(miaChatDeps(), actor).then((threads) => ({ threads })));

/** A new chat. With `personId`, it starts about that lead. */
export const POST = (request: Request) =>
  withActor(async (actor) => {
    const body = NEW_CHAT.parse(await request.json());
    return newChat(miaChatDeps(), actor, body.personId ?? null);
  }, 201);
