import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ANALYTICS_VIEWS, getAnalytics, getFilterOptions, isAnalyticsView, type AnalyticsView } from "@/contexts/analytics/application/analytics-queries";
import { analyticsDeps } from "@/contexts/analytics/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/app/_lib/api";
import { ValidationError } from "@/shared/errors";
import { AnalyticsReportView } from "./report-views";
import { ViewSwitch } from "@/components/shell/view-switch";

export const metadata: Metadata = { title: "Analytics" };

const VIEW_LABELS: Record<AnalyticsView, string> = {
  campaigns: "Campaigns",
  channels: "Channels and senders",
  linkedin: "LinkedIn funnel",
  replies: "Replies",
  timeseries: "By day",
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

export default function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  return (
    <>
      <PageHeader title="Analytics" />
      <div className="page stack-group">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <AnalyticsBody searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

const selectClass = "h-8 w-full max-w-72 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

async function AnalyticsBody({ searchParams }: { searchParams: PageProps<"/analytics">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const params = await searchParams;
  const requestedView = first(params.view) ?? "campaigns";
  const view: AnalyticsView = isAnalyticsView(requestedView) ? requestedView : "campaigns";
  const from = first(params.from);
  const to = first(params.to);
  const campaignId = first(params.campaign);
  const accountId = first(params.account);
  const excludeArchived = first(params.hideArchived) === "1";

  const deps = analyticsDeps();
  const options = await getFilterOptions(deps, actor);
  const result = await getAnalytics(deps, actor, view, { from, to, campaignId, linkedinAccountId: accountId, excludeArchived }).catch((error: unknown) => {
    if (error instanceof ValidationError) return error;
    throw error;
  });

  const query = (overrides: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const values = { view, from, to, campaign: campaignId, account: accountId, hideArchived: excludeArchived ? "1" : undefined, ...overrides };
    for (const [key, value] of Object.entries(values)) if (value) search.set(key, value);
    return search.toString();
  };
  const range = result instanceof ValidationError ? { from: from ?? "", to: to ?? "" } : result.scope.range;

  return (
    <>
      <ViewSwitch label="Analytics views" items={ANALYTICS_VIEWS.map((v) => ({ href: `/analytics?${query({ view: v })}`, label: VIEW_LABELS[v], active: v === view }))} />

      <form action="/analytics" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value={view} />
        <label className="stack-field text-xs text-muted-foreground">
          From
          <Input type="date" name="from" defaultValue={range.from} className="w-40" />
        </label>
        <label className="stack-field text-xs text-muted-foreground">
          To
          <Input type="date" name="to" defaultValue={range.to} className="w-40" />
        </label>
        <label className="stack-field text-xs text-muted-foreground">
          Campaign
          <select name="campaign" defaultValue={campaignId ?? ""} className={selectClass}>
            <option value="">All campaigns</option>
            {options.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.channel === "linkedin" ? "LinkedIn" : "Email"}
                {c.archived ? ", archived" : ""})
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="hideArchived" value="1" defaultChecked={excludeArchived} />
          Hide archived campaigns
        </label>
        {view === "linkedin" && (
          <label className="stack-field text-xs text-muted-foreground">
            LinkedIn account
            <select name="account" defaultValue={accountId ?? ""} className={selectClass}>
              <option value="">All accounts</option>
              {options.linkedinAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={buttonVariants({ size: "sm" })}>
          Apply
        </button>
        {!(result instanceof ValidationError) && (
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/analytics/${view}?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(campaignId ? { campaignId } : {}), ...(excludeArchived ? { excludeArchived: "1" } : {}), ...(accountId && view === "linkedin" ? { linkedinAccountId: accountId } : {}), format: "csv" })}`}
          >
            Export CSV
          </a>
        )}
      </form>

      {result instanceof ValidationError ? (
        <section role="alert" className="stack-field">
          <h2 className="text-sm font-semibold">Check the filters</h2>
          <p className="text-sm text-muted-foreground">{result.message}</p>
        </section>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {result.scope.range.from} to {result.scope.range.to}, {result.scope.timeZone}
          </p>
          <AnalyticsReportView result={result} filtered={Boolean(from || to || campaignId || excludeArchived || (view === "linkedin" && accountId))} />
        </>
      )}
    </>
  );
}
