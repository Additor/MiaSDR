import { z } from "zod";
import { createReplyType, getReplyTaxonomy } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

export const GET = () => withActor(async (actor) => (await getReplyTaxonomy(replyHandlingDeps(), actor)).subcategories);

export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => createReplyType(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json())), 201);
