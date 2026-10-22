import { aiOffMessage } from "@/contexts/integrations/domain/ai-status";
import { aiStatus } from "@/contexts/integrations/infrastructure/composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { withActor } from "@/app/_lib/api";

/**
 * What AI columns run on, for the AI column dialog: the provider and model, or why AI is off worded for the reader.
 * Any member can ask; it carries no key.
 */
export const GET = () =>
  withActor(async (actor) => {
    const status = await aiStatus(actor.organizationId);
    return { status, off: aiOffMessage(status, isOwnerOrAdmin(actor.role) ? "admin" : "member") };
  });
