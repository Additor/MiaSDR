import { TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listCampaigns } from "@/contexts/outreach/application/campaign-management";
import { listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { parseArchiveFilter } from "@/contexts/outreach/domain/campaign";
import { campaignStatusLabel, CHANNEL_LABELS, emailProgressText, linkedinProgressText } from "@/contexts/outreach/domain/campaign-view";
import { campaignDeps, enrollmentAdminStore } from "@/contexts/outreach/infrastructure/composition";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { toActor } from "@/shared/api";
import { LabeledStatusBadge } from "./labeled-status-badge";
import { NewCampaignButton } from "./new-campaign-button";
import { FilterChips } from "@/components/shell/filter-chips";

export const metadata: Metadata = { title: "Campaigns" };

export default function CampaignsPage({ searchParams }: PageProps<"/campaigns">) {
  return (
    <>
      <PageHeader title="Campaigns" />
      <div className="page stack-group">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <CampaignTable searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function CampaignTable({ searchParams }: { searchParams: PageProps<"/campaigns">["searchParams"] }) {
  await connection();
  const raw = (await searchParams).show;
  const show = parseArchiveFilter(raw === "archived" ? "only" : Array.isArray(raw) ? raw[0] : raw);
  const actor = toActor(await requireOrgContext());
  const [email, linkedin, emailSenders, linkedinSenders] = await Promise.all([
    listCampaigns(campaignDeps(), actor, show),
    listLinkedInCampaigns(linkedinCampaignDeps(), actor, show),
    enrollmentAdminStore.listAvailableSenders(actor.organizationId, "email"),
    enrollmentAdminStore.listAvailableSenders(actor.organizationId, "linkedin"),
  ]);
  const campaigns = [
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

  const filters = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <FilterChips
        label="Campaign filter"
        items={(
          [
            ["hide", "Active", "/campaigns"],
            ["only", "Archived", "/campaigns?show=archived"],
            ["all", "All", "/campaigns?show=all"],
          ] as const
        ).map(([value, label, href]) => ({ href, label, active: show === value }))}
      />
      <NewCampaignButton senders={{ email: emailSenders, linkedin: linkedinSenders }} />
    </div>
  );

  if (campaigns.length === 0) {
    return (
      <div className="stack-group">
        {filters}
        <EmptyState
          title={show === "only" ? "No archived campaigns" : "No campaigns yet"}
          description={
            show === "only"
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
      <p className="text-sm text-muted-foreground">
        {email.length.toLocaleString("en-US")} email, {linkedin.length.toLocaleString("en-US")} LinkedIn
      </p>
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
                <Badge variant="outline">{CHANNEL_LABELS[c.channel]}</Badge>
                {c.personal && (
                  <Badge variant="secondary" className="ml-2">
                    Personal
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                <LabeledStatusBadge status={c.status} label={campaignStatusLabel(c.status)} />
                {c.archived && (
                  <Badge variant="outline" className="ml-2">
                    Archived
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{c.steps.toLocaleString("en-US")}</TableCell>
              <TableCell className="text-right tabular-nums">{c.enrolled.toLocaleString("en-US")}</TableCell>
              <TableCell className="text-muted-foreground">
                {c.progress}
                {c.unconfirmed > 0 && (
                  // An unconfirmed send is uncertain, not failed: the warning hue on the icon, the count in plain text.
                  <span className="ml-2 inline-flex items-center gap-1 text-foreground">
                    <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />
                    {c.unconfirmed.toLocaleString("en-US")} unconfirmed
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
