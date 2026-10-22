import { getAnalytics } from "@/contexts/analytics/application/analytics-queries";
import { analyticsDeps } from "@/contexts/analytics/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/**
 * GET /api/linkedin/analytics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&campaignId=<uuid>&accountId=<uuid>
 * The LinkedIn funnel for a window, same data as /api/analytics/linkedin with camelCase date and id parameters.
 */
export const GET = (request: Request) => {
  const params = new URL(request.url).searchParams;
  return withActor(async (actor) => ({
    ok: true,
    ...(await getAnalytics(analyticsDeps(), actor, "linkedin", {
      from: params.get("startDate"),
      to: params.get("endDate"),
      campaignId: params.get("campaignId"),
      linkedinAccountId: params.get("accountId"),
    })),
  }));
};
