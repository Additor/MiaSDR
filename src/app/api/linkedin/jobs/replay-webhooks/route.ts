import { replayFailedLinkedInWebhooks } from "@/contexts/outreach/linkedin/application/linkedin-operations";
import { linkedinOperations } from "@/composition/inbox-filing";
import { withAdmin } from "@/shared/api";

export const POST = () => withAdmin("Only an owner or admin can replay LinkedIn webhooks.", (actor) => replayFailedLinkedInWebhooks(linkedinOperations(), actor));
