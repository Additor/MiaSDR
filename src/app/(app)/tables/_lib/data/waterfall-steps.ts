/** One provider and action of a waterfall. Every step runs the same action, so the steps fill the same columns. */
export interface WaterfallStep {
  providerKey: string;
  actionKey: string;
}

/** The one line under the folded "Spend and timing" section: "Manual runs · reuse 30 days · up to 2 credits a cell". */
export function spendSummary(s: { autoRun: boolean; delay: string; reuseDays: string; maxCost?: string; maxCredits?: string; waitOnLimit?: boolean }): string {
  const parts = [s.autoRun ? "Runs automatically" : "Manual runs"];
  const delay = Math.floor(Number(s.delay) || 0);
  if (delay > 0) parts.push(`${delay} s between calls`);
  const reuse = Math.floor(Number(s.reuseDays) || 0);
  parts.push(reuse > 0 ? `reuse ${reuse} ${reuse === 1 ? "day" : "days"}` : "no reuse");
  if (s.maxCredits?.trim()) parts.push(`up to ${Number(s.maxCredits)} credits a cell`);
  if (s.maxCost?.trim()) parts.push(`up to $${Number(s.maxCost)} a cell`);
  if (s.waitOnLimit) parts.push("waits for rate limits");
  return parts.join(" · ");
}
