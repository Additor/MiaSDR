import { z } from "zod";
import { listInboundEvents } from "@/contexts/outreach/application/inbound-review";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import { withActor } from "@/app/_lib/api";

const query = z.object({
  source: z.enum(["all", "gmail", "linkedin"]).default("all"),
  state: z.enum(["open", "dead", "retrying", "queued", "dismissed", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = (request: Request) =>
  withActor((actor) => listInboundEvents(inboundReviewDeps(), actor, query.parse(Object.fromEntries(new URL(request.url).searchParams))));
