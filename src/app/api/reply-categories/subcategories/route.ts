import { z } from "zod";
import { createSubcategory, getReplyTaxonomy } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export const GET = () => withActor(async (actor) => (await getReplyTaxonomy(replyHandlingDeps(), actor)).subcategories);

export const POST = (request: Request) =>
  withActor(async (actor) => createSubcategory(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json())), 201);
