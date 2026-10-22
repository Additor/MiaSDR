import { syncLinkedInAccounts } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

export const POST = () => withActor((actor) => syncLinkedInAccounts(linkedinManagementDeps(), actor));
