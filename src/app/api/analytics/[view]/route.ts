import { getAnalytics, isAnalyticsView } from "@/contexts/analytics/application/analytics-queries";
import { reportCsv } from "@/contexts/analytics/application/export";
import { analyticsDeps } from "@/contexts/analytics/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { NotFoundError } from "@/shared/errors";

/**
 * GET /api/analytics/{campaigns|channels|linkedin|replies|timeseries}?from=YYYY-MM-DD&to=YYYY-MM-DD&campaignId=<uuid>[&linkedinAccountId=<uuid>][&excludeArchived=1][&format=csv]
 * Days are in the organization's time zone. Without from and to the window is the last 30 days.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/analytics/[view]">) {
  const { view } = await ctx.params;
  const params = new URL(request.url).searchParams;
  return withActor(async (actor) => {
    if (!isAnalyticsView(view)) throw new NotFoundError(`Unknown analytics view: ${view}`);
    const result = await getAnalytics(analyticsDeps(), actor, view, {
      from: params.get("from"),
      to: params.get("to"),
      campaignId: params.get("campaignId"),
      linkedinAccountId: params.get("linkedinAccountId"),
      excludeArchived: params.get("excludeArchived") === "1",
    });
    if (params.get("format") !== "csv") return result;
    const { filename, csv } = reportCsv(result);
    return new Response(csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" },
    });
  });
}
