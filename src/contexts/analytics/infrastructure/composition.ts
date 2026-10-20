import type { AnalyticsDeps } from "../application/analytics-queries";
import { drizzleAnalyticsReadModel } from "./drizzle-analytics-read-model";

export const analyticsDeps = (): AnalyticsDeps => ({ readModel: drizzleAnalyticsReadModel });
