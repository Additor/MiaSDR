import { getLinkedInJobsOverview } from "@/contexts/outreach/linkedin/application/linkedin-operations";
import { linkedinOperations } from "@/composition/inbox-filing";
import { withAdmin } from "@/shared/api";

export const GET = () => withAdmin("Only an owner or admin can see LinkedIn jobs.", (actor) => getLinkedInJobsOverview(linkedinOperations(), actor));
