import { registerLinkedInWebhooks } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

export const POST = () => withActor((actor) => registerLinkedInWebhooks(linkedinManagementDeps(), actor));
