import { withActor } from "@/app/_lib/api";
import { retryAnswer } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";
import { turnStream } from "../../_lib/turn-stream";

/** A new answer to the chat's last question, streamed like a first one. 409 `nothing_to_retry` when that answer is complete. */
export async function POST(_request: Request, ctx: RouteContext<"/api/mia/threads/[id]/retry">) {
  const { id } = await ctx.params;
  return withActor((actor) => turnStream((listener) => retryAnswer(miaChatDeps(), actor, id, listener)));
}
