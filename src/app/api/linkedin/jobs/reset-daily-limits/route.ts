import { resetLinkedInDailyCounters } from "@/contexts/outreach/linkedin/application/linkedin-operations";
import { linkedinOperations } from "@/composition/inbox-filing";
import { withAdmin } from "@/shared/api";

export const POST = () => withAdmin("Only an owner or admin can reset LinkedIn counters.", (actor) => resetLinkedInDailyCounters(linkedinOperations(), actor));
