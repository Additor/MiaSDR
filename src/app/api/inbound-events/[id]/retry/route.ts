import { retryInboundEvent } from "@/contexts/outreach/application/inbound-review";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import { withActor } from "@/app/_lib/api";

export const POST = async (_request: Request, { params }: RouteContext<"/api/inbound-events/[id]/retry">) => {
  const { id } = await params;
  return withActor((actor) => retryInboundEvent(inboundReviewDeps(), actor, id));
};
