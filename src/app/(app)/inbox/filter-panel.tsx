import { FILTER_SELECT, FilterField, FilterPanel, type ActiveFilterChip } from "@/components/shell/filter-panel";
import { Input } from "@/components/ui/input";
import type { InboxFilterOptions } from "@/contexts/conversations/application/ports";
import { categoryLabel } from "@/contexts/conversations/domain/crm";
import { inboxHref, INBOX_CATEGORIES, type InboxParams } from "@/contexts/conversations/domain/inbox-filter";

/** The filters in force as chips, each one a link that removes it. */
export function activeFilterChips(params: InboxParams, options: InboxFilterOptions): ActiveFilterChip[] {
  const label = (list: Array<{ id?: string; key?: string; label: string }>, value: string) => list.find((o) => (o.id ?? o.key) === value)?.label ?? value;
  const chips: ActiveFilterChip[] = [];
  const drop = (patch: Partial<InboxParams>) => inboxHref(params, { ...patch, page: 1 });
  for (const id of params.leadIds) chips.push({ key: `lead-${id}`, name: "Person", value: label(options.leads, id), href: drop({ leadIds: params.leadIds.filter((v) => v !== id) }) });
  if (params.leadQuery) chips.push({ key: "leadq", name: "Person", value: params.leadQuery, href: drop({ leadQuery: "" }) });
  for (const id of params.campaignIds) chips.push({ key: `c-${id}`, name: "Campaign", value: label(options.campaigns, id), href: drop({ campaignIds: params.campaignIds.filter((v) => v !== id) }) });
  for (const id of params.mailboxIds) chips.push({ key: `m-${id}`, name: "Mailbox", value: label(options.mailboxes, id), href: drop({ mailboxIds: params.mailboxIds.filter((v) => v !== id) }) });
  for (const k of params.subcategoryKeys) chips.push({ key: `s-${k}`, name: "Reply subcategory", value: label(options.subcategories, k), href: drop({ subcategoryKeys: params.subcategoryKeys.filter((v) => v !== k) }) });
  for (const k of params.categoryKeys) chips.push({ key: `k-${k}`, name: "Reply category", value: categoryLabel(k), href: drop({ categoryKeys: params.categoryKeys.filter((v) => v !== k) }) });
  if (params.dateMode !== "all") {
    const value = params.dateMode === "custom" ? `${params.dateFrom || "any"} to ${params.dateTo || "any"}` : params.dateMode;
    chips.push({ key: "date", name: "Dates", value, href: drop({ dateMode: "all", dateFrom: "", dateTo: "" }) });
  }
  return chips;
}

/** The Inbox without any filter, keeping search and view. */
export const clearedInboxHref = (params: InboxParams) =>
  inboxHref(params, { leadIds: [], leadQuery: "", campaignIds: [], mailboxIds: [], subcategoryKeys: [], categoryKeys: [], dateMode: "all", dateFrom: "", dateTo: "", page: 1 });

/**
 * A plain GET form: Apply filters rebuilds the URL; `clearedInboxHref` drops every filter but keeps search and view. The page
 * passes it to the toolbar, which shows it under the Filters button.
 */
export function InboxFilterForm({ params, options }: { params: InboxParams; options: InboxFilterOptions }) {
  const first = <T,>(list: T[]) => list[0] ?? "";
  return (
    <form action="/inbox" method="get" aria-label="Inbox filters">
      {params.query && <input type="hidden" name="q" value={params.query} />}
      {params.view !== "all" && <input type="hidden" name="view" value={params.view} />}
      {params.leadIds.map((id) => (
        <input key={id} type="hidden" name="lead" value={id} />
      ))}
      <FilterPanel>
        <FilterField label="Person name or email">
          <Input name="lead" defaultValue={params.leadQuery} placeholder="Ada or ada@example.com" className="max-sm:h-11" />
        </FilterField>
        <FilterField label="Campaign">
          <select name="campaign" defaultValue={first(params.campaignIds)} className={FILTER_SELECT}>
            <option value="">Any campaign</option>
            {options.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Mailbox">
          <select name="mailbox" defaultValue={first(params.mailboxIds)} className={FILTER_SELECT}>
            <option value="">Any mailbox</option>
            {options.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Reply subcategory">
          <select name="subcategory" defaultValue={first(params.subcategoryKeys)} className={FILTER_SELECT}>
            <option value="">Any reply subcategory</option>
            {options.subcategories.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Reply category">
          <select name="category" defaultValue={first(params.categoryKeys)} className={FILTER_SELECT}>
            <option value="">Any reply category</option>
            {INBOX_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {categoryLabel(k)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Last message">
          <select name="range" defaultValue={params.dateMode} className={FILTER_SELECT}>
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="custom">Custom range</option>
          </select>
        </FilterField>
        <FilterField label="From (date, custom range)">
          <Input name="from" type="date" defaultValue={params.dateFrom} className="max-sm:h-11" />
        </FilterField>
        <FilterField label="To (date, custom range)">
          <Input name="to" type="date" defaultValue={params.dateTo} className="max-sm:h-11" />
        </FilterField>
      </FilterPanel>
    </form>
  );
}
