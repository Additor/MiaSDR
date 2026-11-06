import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { askMia } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";
import { turnStream } from "../../_lib/turn-stream";

const QUESTION = z.object({ clientId: z.string().max(100), text: z.string().max(20_000) }).strict();

/**
 * Asks Mia and streams the answer as JSON lines. 409 `turn_running` while another answer is going in the chat,
 * `mia_chat_limit` past the hourly questions, `mia_daily_limit` with `retryAfterSeconds` past the day's tokens.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/mia/threads/[id]/messages">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = QUESTION.parse(await request.json());
    return turnStream((listener) => askMia(miaChatDeps(), actor, id, body, listener));
  });
}
