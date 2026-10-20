import { campaignsTable, channelsTable, linkedinTable, repliesTable, timeSeriesTable, toCsv } from "../domain/export";
import type { AnalyticsResult } from "./analytics-queries";

/** The report as CSV text, with a file name that carries the view and the window. */
export function reportCsv(result: AnalyticsResult): { filename: string; csv: string } {
  const table = (() => {
    switch (result.view) {
      case "campaigns":
        return campaignsTable(result.data);
      case "channels":
        return channelsTable(result.data);
      case "linkedin":
        return linkedinTable(result.data);
      case "replies":
        return repliesTable(result.data);
      case "timeseries":
        return timeSeriesTable(result.data);
    }
  })();
  return { filename: `analytics-${result.view}-${result.scope.range.from}-to-${result.scope.range.to}.csv`, csv: toCsv(table) };
}
