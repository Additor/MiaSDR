"use client";

import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/shell/empty-state";
import { ListPager } from "@/components/shell/list-pager";
import { Time } from "@/components/shell/time";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AUDIT_AREAS, type AuditArea } from "@/contexts/tenancy/application/audit-log";
import { humanizeToken } from "@/shared/humanize";
import { RULED_LIST, RULED_ROW } from "../settings-section";

interface Row {
  id: string;
  action: string;
  actorName: string | null;
  entityType: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** A label for every area the server filters by. The record type makes a new area fail the build until it has one. */
const AREA_LABEL: Record<AuditArea, string> = {
  organization: "Organization",
  integration: "Integrations",
  mailbox: "Mailboxes",
  suppression: "Suppression list",
  deal_stage: "Pipeline stages",
  deal: "Deals",
  company: "Companies",
  person: "People",
  enrollment: "Campaign leads",
  linkedin: "LinkedIn",
  ai_jobs: "AI jobs",
  search_batch: "LinkedIn searches",
};

const AREA_ITEMS = [{ value: "all", label: "Everything" }, ...AUDIT_AREAS.map((area) => ({ value: area, label: AREA_LABEL[area] }))];

/** Exact copy for the actions people look for. Anything else reads through `humanizeToken`. */
const ACTION_LABEL: Record<string, string> = {
  "organization.renamed": "Renamed the organization",
  "organization.timezone_changed": "Changed the time zone",
  "organization.ai_cap_changed": "Changed the AI limit for unknown senders",
  "organization.phone_country_changed": "Changed the default phone country",
  "organization.sending_paused": "Paused all sending",
  "organization.sending_resumed": "Resumed sending",
  "integration.saved": "Saved an API key",
  "integration.deleted": "Removed an API key",
  "integration.ai_model_changed": "Changed the AI model",
  "integration.secret_viewed": "Viewed the webhook secret",
  "mailbox.test_sent": "Sent a test email",
  "linkedin.connect_link_created": "Created a LinkedIn connection link",
  "linkedin.reconnect_link_created": "Created a LinkedIn reconnect link",
  "suppression.added": "Added addresses to the suppression list",
  "suppression.removed": "Removed an address from the suppression list",
  "deal_stage.created": "Added a pipeline stage",
  "deal_stage.renamed": "Renamed a pipeline stage",
  "deal_stage.reordered": "Reordered the pipeline stages",
  "deal_stage.deleted": "Deleted a pipeline stage",
  "deal_stage.defaults_created": "Created the default pipeline stages",
  "linkedin.webhooks_replayed": "Replayed LinkedIn deliveries",
  "linkedin.daily_counters_reset": "Reset the LinkedIn daily counters",
  "linkedin.limits_changed": "Changed LinkedIn account limits",
  "linkedin.account_connected": "Connected a LinkedIn account",
  "ai_jobs.requeued": "Requeued AI jobs",
  "ai_jobs.auto_requeued": "Requeued AI jobs automatically",
  "company.merged": "Merged two companies",
  "company.deleted": "Deleted a company",
  "person.deleted": "Deleted a person",
};

const actionLabel = (action: string) => ACTION_LABEL[action] ?? humanizeToken(action.replace(".", " "));

/** A short line of the facts in `meta`: "from A to B" first, then simple values. Arrays and objects stay out. */
function details(meta: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if ((typeof meta.from === "string" || typeof meta.from === "number") && (typeof meta.to === "string" || typeof meta.to === "number")) parts.push(`${meta.from} → ${meta.to}`);
  for (const [key, value] of Object.entries(meta)) {
    // Ids and machine timestamps mean nothing to a reader.
    if (key === "from" || key === "to" || key === "ids" || /(^id|Id|_id|At|_at)$/.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") parts.push(`${humanizeToken(key).toLowerCase()} ${value}`);
  }
  return parts.length > 0 ? parts.slice(0, 4).join(", ") : null;
}

export function AuditLogPanel({ rows, total, page, pageSize, area }: { rows: Row[]; total: number; page: number; pageSize: number; area: string }) {
  const router = useRouter();
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const href = (next: { area?: string; page?: number }) => {
    const params = new URLSearchParams();
    const a = next.area ?? area;
    if (a !== "all") params.set("area", a);
    if ((next.page ?? 1) > 1) params.set("page", String(next.page));
    const query = params.toString();
    return `/settings/audit-log${query ? `?${query}` : ""}`;
  };

  return (
    <div className="stack-group">
      <p className="text-sm text-muted-foreground">Changes people made to settings, keys, deals and companies, newest first. Owners and admins read them here, and nobody can edit them.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select items={AREA_ITEMS} value={area} onValueChange={(v) => v && router.push(href({ area: v }))}>
          <SelectTrigger aria-label="Area" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AREA_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nothing recorded" description={area === "all" ? "Changes show here once someone makes one." : "No change in this area yet."} />
      ) : (
        <ul className={cn(RULED_LIST, "text-sm")} aria-label="Audit log">
          {rows.map((row) => {
            const line = details(row.meta);
            return (
              <li key={row.id} className={cn(RULED_ROW, "grid gap-0.5")}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{actionLabel(row.action)}</span>
                  <span className="text-muted-foreground">
                    {row.actorName ?? "MiaSDR"}, <Time value={row.createdAt} />
                  </span>
                </div>
                {line && <p className="break-words text-muted-foreground">{line}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <ListPager total={total} page={page} pageCount={pageCount} noun={["change", "changes"]} hrefFor={(p) => href({ page: p })} />
    </div>
  );
}
