import type { InboundReviewDeps } from "../application/inbound-review";
import { drizzleInboundReviewStore } from "./drizzle-inbound-review-store";

export const inboundReviewDeps = (): InboundReviewDeps => ({ store: drizzleInboundReviewStore, now: () => new Date() });
