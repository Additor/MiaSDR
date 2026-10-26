import { REPLY_TYPE_GROUPS } from "@/contexts/conversations/domain/reply-handling";
import { getReplyTypeCatalog } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

/** The four fixed categories, the pipeline's subcategories with usage counts, and its AI settings. */
export const GET = () => withActor(async (actor) => ({ categories: REPLY_TYPE_GROUPS, ...(await getReplyTypeCatalog(replyHandlingDeps(), actor)) }));
