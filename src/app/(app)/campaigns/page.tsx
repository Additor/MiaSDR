import { TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Badge } from "@/components/ui/badge";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listCampaigns } from "@/contexts/outreach/application/campaign-management";
import { listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { parseArchiveFilter } from "@/contexts/outreach/domain/campaign";
import { emailProgressText, linkedinProgressText } from "@/contexts/outreach/domain/campaign-view";
import { campaignDeps, enrollmentAdminStore } from "@/contexts/outreach/infrastructure/composition";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { toActor } from "@/app/_lib/api";
import { formatCount } from "@/shared/format-number";
import { ChannelName } from "./[id]/_components/channel-name";
import { CampaignStatusToken } from "./[id]/_components/campaign-status-token";
import { NewCampaignButton } from "./new-campaign-button";
import { FilterChips } from "@/components/shell/filter-chips";
import { ListPager } from "@/components/shell/list-pager";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { SearchField } from "@/components/shell/search-field";

export const metadata: Metadata = { title: "Campaigns" };

export default function CampaignsPage({ searchParams }: PageProps<"/campaigns">) {
  return (
    <>
      <PageHeader
        title="Campaigns"
        actions={
          <Suspense fallback={null}>
            <NewCampaign />
          </Suspense>
        }
      />
      <div className="page stack-group">
        <Suspense fallback={<PageSkeleton shape="list" />}>
          <CampaignTable searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

/** The create action sits in the header, as Import does on Leads. It needs the senders the dialog offers. */
async function NewCampaign() {
  await connection();
  const actor = toActor(await requireOrgContext());
  const [email, linkedin] = await Promise.all([enrollmentAdminStore.listAvailableSenders(actor.organizationId, "email"), enrollmentAdminStore.listAvailableSenders(actor.organizationId, "linkedin")]);
  return <NewCampaignButton senders={{ email, linkedin }} />;
}

async function CampaignTable({ searchParams }: { searchParams: PageProps<"/campaigns">["searchParams"] }) {
  await connection();
  const params = await searchParams;
  const raw = params.show;
  const query = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() ?? "";
  const show = parseArchiveFilter(raw === "archived" ? "only" : Array.isArray(raw) ? raw[0] : raw);
  const actor = toActor(await requireOrgContext());
  const [email, linkedin] = await Promise.all([listCampaigns(campaignDeps(), actor, show), listLinkedInCampaigns(linkedinCampaignDeps(), actor, show)]);
  const all = [
    ...email.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      channel: "email" as const,
      personal: false,
      steps: c.steps,
      enrolled: c.enrolled,
      createdAt: c.createdAt,
      progress: emailProgressText(c),
      unconfirmed: c.unconfirmed,
      archived: c.archivedAt !== null,
    })),
    ...linkedin.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      channel: "linkedin" as const,
      personal: c.type === "personal",
      steps: c.steps.length,
      enrolled: c.enrolled,
      createdAt: c.createdAt,
      unconfirmed: 0,
      archived: c.archivedAt !== null,
      progress: linkedinProgressText(c),
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const needle = query.toLowerCase();
  const campaigns = needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all;
  const showParam = show === "only" ? "archived" : show === "all" ? "all" : null;

  const filters = (
    <ListToolbar>
      <FilterChips
        label="Campaign filter"
        items={(
          [
            ["hide", "Active", "/campaigns"],
            ["only", "Archived", "/campaigns?show=archived"],
            ["all", "All", "/campaigns?show=all"],
          ] as const
        ).map(([value, label, href]) => ({ href: query ? `${href}${href.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}` : href, label, active: show === value }))}
      />
      <form action="/campaigns" className="flex min-w-48 flex-1 items-center">
        {showParam && <input type="hidden" name="show" value={showParam} />}
        <SearchField label="Search campaigns" defaultValue={query} placeholder="Search campaign names" className="max-w-sm" />
      </form>
    </ListToolbar>
  );

  if (campaigns.length === 0) {
    return (
      <div className="stack-group">
        {filters}
        <EmptyState
          title={query ? "No campaigns match" : show === "only" ? "No archived campaigns" : "No campaigns yet"}
          description={
            query
              ? "Try a different name."
              : show === "only"
              ? "Archive a completed campaign to move it here. Its sends and analytics stay."
              : "Create one, add leads from your database, then start it once a mailbox or LinkedIn account is connected."
          }
        />
      </div>
    );
  }
  return (
    <div className="stack-group">
      {filters}
      <ScrollableTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Steps</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead>Progress</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={`${c.channel}-${c.id}`} className={rowLinkClasses}>
                <TableCell>
                  <RowLink href={`/campaigns/${c.id}`}>{c.name}</RowLink>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <ChannelName channel={c.channel} />
                    {c.personal && <Badge variant="outline">Personal</Badge>}
                  </span>
                </TableCell>
                <TableCell>
                  <CampaignStatusToken status={c.status} archived={c.archived} compact />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.steps)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.enrolled)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {c.progress}
                  {c.unconfirmed > 0 && (
                    // An unconfirmed send is uncertain, not failed: the warning hue on the icon, the count in plain text.
                    <span className="ml-2 inline-flex items-center gap-1 text-foreground">
                      <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />
                      {formatCount(c.unconfirmed)} unconfirmed
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollableTable>
      <ListPager total={campaigns.length} page={1} pageCount={1} noun={["campaign", "campaigns"]} hrefFor={() => "/campaigns"} />
    </div>
  );
}
