import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { AppliedFilters, type AppliedFilter } from "@/components/shell/filter-chip";
import { CheckField, DateRangeField, FilterSection, SelectField } from "@/components/shell/filter-fields";
import { FilterPopover } from "@/components/shell/filter-popover";
import { ListToolbar } from "@/components/shell/list-toolbar";
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

const campaignLabel = (c: { name: string; channel: string; archived: boolean }) => `${c.name} (${c.channel === "linkedin" ? "LinkedIn" : "Email"}${c.archived ? ", archived" : ""})`;

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
  const campaign = options.campaigns.find((c) => c.id === campaignId);
  const account = options.linkedinAccounts.find((a) => a.id === accountId);
  const chips: AppliedFilter[] = [];
  if (from) chips.push({ key: "from", name: "From", value: from, href: `/analytics?${query({ from: undefined })}` });
  if (to) chips.push({ key: "to", name: "To", value: to, href: `/analytics?${query({ to: undefined })}` });
  if (campaignId) chips.push({ key: "campaign", name: "Campaign", value: campaign ? campaignLabel(campaign) : campaignId, href: `/analytics?${query({ campaign: undefined })}` });
  if (excludeArchived) chips.push({ key: "hideArchived", name: "Hide archived campaigns", value: "Yes", href: `/analytics?${query({ hideArchived: undefined })}` });
  if (view === "linkedin" && accountId) chips.push({ key: "account", name: "LinkedIn account", value: account?.name ?? accountId, href: `/analytics?${query({ account: undefined })}` });

  return (
    <>
      <ViewSwitch label="Analytics views" items={ANALYTICS_VIEWS.map((v) => ({ href: `/analytics?${query({ view: v })}`, label: VIEW_LABELS[v], active: v === view }))} />

      <ListToolbar
        filters={
          <FilterPopover count={chips.length} form={{ action: "/analytics", label: "Filter analytics", hidden: <input type="hidden" name="view" value={view} /> }}>
            <FilterSection title="Dates">
              <DateRangeField label="Dates" from={{ name: "from", value: from ?? "" }} to={{ name: "to", value: to ?? "" }} />
            </FilterSection>
            <FilterSection title="Campaigns">
              <SelectField label="Campaign" name="campaign" defaultValue={campaignId ?? ""} options={[{ value: "", label: "All campaigns" }, ...options.campaigns.map((c) => ({ value: c.id, label: campaignLabel(c) }))]} />
              <CheckField label="Hide archived campaigns" name="hideArchived" defaultChecked={excludeArchived} />
              {view === "linkedin" && (
                <SelectField label="LinkedIn account" name="account" defaultValue={accountId ?? ""} options={[{ value: "", label: "All accounts" }, ...options.linkedinAccounts.map((a) => ({ value: a.id, label: a.name }))]} />
              )}
            </FilterSection>
          </FilterPopover>
        }
        end={
          !(result instanceof ValidationError) && (
            <a
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-sm:h-11")}
              href={`/api/analytics/${view}?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(campaignId ? { campaignId } : {}), ...(excludeArchived ? { excludeArchived: "1" } : {}), ...(accountId && view === "linkedin" ? { linkedinAccountId: accountId } : {}), format: "csv" })}`}
            >
              Export CSV
            </a>
          )
        }
      />
      <AppliedFilters chips={chips} clear={{ href: `/analytics?${query({ from: undefined, to: undefined, campaign: undefined, account: undefined, hideArchived: undefined })}` }} />

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
