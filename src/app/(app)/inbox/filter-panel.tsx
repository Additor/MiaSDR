import type { AppliedFilter } from "@/components/shell/filter-chip";
import { DateRangeField, SelectField, TextField } from "@/components/shell/filter-fields";
import { FilterPopover } from "@/components/shell/filter-popover";
import type { InboxFilterOptions } from "@/contexts/conversations/application/ports";
import { categoryLabel } from "@/contexts/conversations/domain/reply-handling";
import { inboxHref, INBOX_CATEGORIES, type InboxParams } from "@/contexts/conversations/domain/inbox-filter";

/** The filters in force as chips, each one a link that removes it. */
export function activeFilterChips(params: InboxParams, options: InboxFilterOptions): AppliedFilter[] {
  const label = (list: Array<{ id?: string; key?: string; label: string }>, value: string) => list.find((o) => (o.id ?? o.key) === value)?.label ?? value;
  const chips: AppliedFilter[] = [];
  const drop = (patch: Partial<InboxParams>) => inboxHref(params, { ...patch, page: 1 });
  for (const id of params.leadIds) chips.push({ key: `lead-${id}`, name: "Person", value: label(options.leads, id), href: drop({ leadIds: params.leadIds.filter((v) => v !== id) }) });
  if (params.leadQuery) chips.push({ key: "leadq", name: "Person", value: params.leadQuery, href: drop({ leadQuery: "" }) });
  for (const id of params.campaignIds) chips.push({ key: `c-${id}`, name: "Campaign", value: label(options.campaigns, id), href: drop({ campaignIds: params.campaignIds.filter((v) => v !== id) }) });
  for (const id of params.mailboxIds) chips.push({ key: `m-${id}`, name: "Mailbox", value: label(options.mailboxes, id), href: drop({ mailboxIds: params.mailboxIds.filter((v) => v !== id) }) });
  for (const k of params.replyTypeKeys) chips.push({ key: `s-${k}`, name: "Reply subcategory", value: label(options.subcategories, k), href: drop({ replyTypeKeys: params.replyTypeKeys.filter((v) => v !== k) }) });
  for (const k of params.groupKeys) chips.push({ key: `k-${k}`, name: "Reply category", value: categoryLabel(k), href: drop({ groupKeys: params.groupKeys.filter((v) => v !== k) }) });
  if (params.dateMode !== "all") {
    const value = params.dateMode === "custom" ? `${params.dateFrom || "any"} to ${params.dateTo || "any"}` : params.dateMode;
    chips.push({ key: "date", name: "Dates", value, href: drop({ dateMode: "all", dateFrom: "", dateTo: "" }) });
  }
  return chips;
}

/** The Inbox without any filter, keeping search and view. */
export const clearedInboxHref = (params: InboxParams) =>
  inboxHref(params, { leadIds: [], leadQuery: "", campaignIds: [], mailboxIds: [], replyTypeKeys: [], groupKeys: [], dateMode: "all", dateFrom: "", dateTo: "", page: 1 });

/**
 * The Filters popover as its own GET form: Apply rebuilds the URL; `clearedInboxHref` drops every filter but keeps search
 * and view. The chips under the toolbar show what applies.
 */
export function InboxFilters({ params, options, count }: { params: InboxParams; options: InboxFilterOptions; count: number }) {
  const first = <T,>(list: T[]) => list[0] ?? "";
  return (
    <FilterPopover
      count={count}
      form={{
        action: "/inbox",
        label: "Inbox filters",
        hidden: (
          <>
            {params.query && <input type="hidden" name="q" value={params.query} />}
            {params.view !== "all" && <input type="hidden" name="view" value={params.view} />}
            {params.leadIds.map((id) => (
              <input key={id} type="hidden" name="lead" value={id} />
            ))}
          </>
        ),
      }}
    >
      <TextField label="Person name or email" name="lead" defaultValue={params.leadQuery} placeholder="Ada or ada@example.com" />
      <SelectField label="Campaign" name="campaign" defaultValue={first(params.campaignIds)}>
        <option value="">Any campaign</option>
        {options.campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </SelectField>
      <SelectField label="Mailbox" name="mailbox" defaultValue={first(params.mailboxIds)}>
        <option value="">Any mailbox</option>
        {options.mailboxes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </SelectField>
      <SelectField label="Reply category" name="category" defaultValue={first(params.groupKeys)}>
        <option value="">Any reply category</option>
        {INBOX_CATEGORIES.map((k) => (
          <option key={k} value={k}>
            {categoryLabel(k)}
          </option>
        ))}
      </SelectField>
      <SelectField label="Reply subcategory" name="subcategory" defaultValue={first(params.replyTypeKeys)}>
        <option value="">Any reply subcategory</option>
        {options.subcategories.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </SelectField>
      <SelectField label="Last message" name="range" defaultValue={params.dateMode}>
        <option value="all">All time</option>
        <option value="today">Today</option>
        <option value="yesterday">Yesterday</option>
        <option value="custom">Custom range</option>
      </SelectField>
      <DateRangeField label="Custom range" from={{ name: "from", value: params.dateFrom }} to={{ name: "to", value: params.dateTo }} />
    </FilterPopover>
  );
}
