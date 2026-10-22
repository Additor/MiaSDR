import { REPLY_CATEGORIES } from "@/contexts/conversations/domain/reply-handling";
import { getReplyTaxonomy } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

/** The four fixed categories, the pipeline's subcategories with usage counts, and its AI settings. */
export const GET = () => withActor(async (actor) => ({ categories: REPLY_CATEGORIES, ...(await getReplyTaxonomy(replyHandlingDeps(), actor)) }));
