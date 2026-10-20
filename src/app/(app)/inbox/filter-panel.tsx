import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InboxFilterOptions } from "@/contexts/conversations/application/ports";
import { categoryLabel } from "@/contexts/conversations/domain/crm";
import { inboxHref, INBOX_CATEGORIES, type InboxParams } from "@/contexts/conversations/domain/inbox-filter";
import { cn } from "@/lib/utils";

const selectClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:[color-scheme:dark]";

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="stack-field">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** Chips for the filters in force, each one a link that removes it. */
export function ActiveFilters({ params, options }: { params: InboxParams; options: InboxFilterOptions }) {
  const label = (list: Array<{ id?: string; key?: string; label: string }>, value: string) => list.find((o) => (o.id ?? o.key) === value)?.label ?? value;
  const chips: Array<{ key: string; text: string; href: string }> = [];
  const drop = (patch: Partial<InboxParams>) => inboxHref(params, { ...patch, page: 1 });
  for (const id of params.leadIds) chips.push({ key: `lead-${id}`, text: `Person: ${label(options.leads, id)}`, href: drop({ leadIds: params.leadIds.filter((v) => v !== id) }) });
  if (params.leadQuery) chips.push({ key: "leadq", text: `Person: ${params.leadQuery}`, href: drop({ leadQuery: "" }) });
  for (const id of params.campaignIds) chips.push({ key: `c-${id}`, text: `Campaign: ${label(options.campaigns, id)}`, href: drop({ campaignIds: params.campaignIds.filter((v) => v !== id) }) });
  for (const id of params.mailboxIds) chips.push({ key: `m-${id}`, text: `Mailbox: ${label(options.mailboxes, id)}`, href: drop({ mailboxIds: params.mailboxIds.filter((v) => v !== id) }) });
  for (const k of params.subcategoryKeys) chips.push({ key: `s-${k}`, text: `Reply subcategory: ${label(options.subcategories, k)}`, href: drop({ subcategoryKeys: params.subcategoryKeys.filter((v) => v !== k) }) });
  for (const k of params.categoryKeys) chips.push({ key: `k-${k}`, text: `Reply category: ${categoryLabel(k)}`, href: drop({ categoryKeys: params.categoryKeys.filter((v) => v !== k) }) });
  if (params.dateMode !== "all") {
    const text = params.dateMode === "custom" ? `Dates: ${params.dateFrom || "any"} to ${params.dateTo || "any"}` : `Dates: ${params.dateMode}`;
    chips.push({ key: "date", text, href: drop({ dateMode: "all", dateFrom: "", dateTo: "" }) });
  }
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Active filters">
      {chips.map((c) => (
        <li key={c.key}>
          <Link href={c.href} aria-label={`Remove filter ${c.text}`} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs hover:bg-muted/70">
            {c.text}
            <span aria-hidden>×</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A plain GET form: "Apply filters" rebuilds the URL, "Clear filters" drops every filter but keeps search and view. The page
 * shows it below the search line when the Filters button is open (`search-and-filters.tsx`).
 */
export function FilterPanel({ params, options }: { params: InboxParams; options: InboxFilterOptions }) {
  const first = <T,>(list: T[]) => list[0] ?? "";
  return (
    <div className="rounded-lg border">
      <form action="/inbox" method="get" aria-label="Inbox filters" className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {params.query && <input type="hidden" name="q" value={params.query} />}
        {params.view !== "all" && <input type="hidden" name="view" value={params.view} />}
        {params.leadIds.map((id) => (
          <input key={id} type="hidden" name="lead" value={id} />
        ))}
        <Field id="f-lead" label="Person name or email">
          <Input id="f-lead" name="lead" defaultValue={params.leadQuery} placeholder="Ada or ada@example.com" />
        </Field>
        <Field id="f-campaign" label="Campaign">
          <select id="f-campaign" name="campaign" defaultValue={first(params.campaignIds)} className={selectClass}>
            <option value="">Any campaign</option>
            {options.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="f-mailbox" label="Mailbox">
          <select id="f-mailbox" name="mailbox" defaultValue={first(params.mailboxIds)} className={selectClass}>
            <option value="">Any mailbox</option>
            {options.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="f-subcategory" label="Reply subcategory">
          <select id="f-subcategory" name="subcategory" defaultValue={first(params.subcategoryKeys)} className={selectClass}>
            <option value="">Any reply subcategory</option>
            {options.subcategories.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="f-category" label="Reply category">
          <select id="f-category" name="category" defaultValue={first(params.categoryKeys)} className={selectClass}>
            <option value="">Any reply category</option>
            {INBOX_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {categoryLabel(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="f-range" label="Last message">
          <select id="f-range" name="range" defaultValue={params.dateMode} className={selectClass}>
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="custom">Custom range</option>
          </select>
        </Field>
        <Field id="f-from" label="From (date, custom range)">
          <Input id="f-from" name="from" type="date" defaultValue={params.dateFrom} />
        </Field>
        <Field id="f-to" label="To (date, custom range)">
          <Input id="f-to" name="to" type="date" defaultValue={params.dateTo} />
        </Field>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
          <Button type="submit" size="sm">
            Apply filters
          </Button>
          <Link href={inboxHref(params, { leadIds: [], leadQuery: "", campaignIds: [], mailboxIds: [], subcategoryKeys: [], categoryKeys: [], dateMode: "all", dateFrom: "", dateTo: "", page: 1 })} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            Clear filters
          </Link>
        </div>
      </form>
    </div>
  );
}
