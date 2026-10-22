import { z } from "zod";
import { listIdentityExceptions } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function GET(request: Request) {
  const status = z.enum(["open", "resolved", "ignored"]).catch("open").parse(new URL(request.url).searchParams.get("status") ?? "open");
  return withActor((actor) => listIdentityExceptions(replyHandlingDeps(), actor, status));
}
