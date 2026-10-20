import { dismissInboundEvent } from "@/contexts/outreach/application/inbound-review";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import { withActor } from "@/shared/api";

export const POST = async (_request: Request, { params }: RouteContext<"/api/inbound-events/[id]/dismiss">) => {
  const { id } = await params;
  return withActor((actor) => dismissInboundEvent(inboundReviewDeps(), actor, id));
};
