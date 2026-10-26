import type { AppliedFilter } from "@/components/shell/filter-chip";
import { CheckField, DateRangeField, SelectField } from "@/components/shell/filter-fields";
import { FilterPopover } from "@/components/shell/filter-popover";
import { QUEUE_GROUPS, QUEUE_GROUP_LABELS } from "@/contexts/conversations/actions/domain/action-queue";
import { REPLY_CATEGORIES } from "@/contexts/conversations/domain/reply-handling";

export interface QueueFilterValues {
  category: string;
  channel: string;
  group: string;
  subcategoryId: string;
  campaignId: string;
  dueAfter: string;
  dueBefore: string;
  errorsOnly: boolean;
}

/**
 * The Filters popover as its own GET form: the filters live in the URL, so a filtered queue can be linked. The chips
 * under the toolbar show what applies.
 */
export function QueueFilters({
  values,
  scope,
  count,
  subcategories,
  campaigns,
}: {
  values: QueueFilterValues;
  /** The scope chip in view. The form carries it, so applying filters keeps whose work is shown. */
  scope: string;
  count: number;
  subcategories: Array<{ id: string; name: string; categoryKey: string }>;
  campaigns: Array<{ id: string; name: string }>;
}) {
  return (
    <FilterPopover count={count} form={{ action: "/actions", label: "Queue filters", hidden: <input type="hidden" name="scope" value={scope} /> }}>
      <SelectField label="Group" name="group" defaultValue={values.group}>
        <option value="">All groups</option>
        {QUEUE_GROUPS.map((g) => (
          <option key={g} value={g}>
            {QUEUE_GROUP_LABELS[g].title}
          </option>
        ))}
      </SelectField>
      <SelectField label="Channel" name="channel" defaultValue={values.channel}>
        <option value="">All channels</option>
        <option value="email">Email</option>
        <option value="linkedin">LinkedIn</option>
      </SelectField>
      <SelectField label="Campaign" name="campaignId" defaultValue={values.campaignId}>
        <option value="">All campaigns</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <SelectField label="Reply category" name="category" defaultValue={values.category}>
        <option value="">All reply categories</option>
        {REPLY_CATEGORIES.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
        <option value="unclassified">Unclassified</option>
      </SelectField>
      <SelectField label="Reply subcategory" name="subcategoryId" defaultValue={values.subcategoryId}>
        <option value="">All reply subcategories</option>
        {subcategories.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <DateRangeField label="Due" from={{ name: "dueAfter", value: values.dueAfter }} to={{ name: "dueBefore", value: values.dueBefore }} />
      <CheckField label="Errors only" name="errorsOnly" defaultChecked={values.errorsOnly} />
    </FilterPopover>
  );
}

/** The queue's filters in force as chips, each a link to the queue without it. */
export function queueFilterChips(
  values: QueueFilterValues,
  scope: string,
  names: { subcategories: Array<{ id: string; name: string }>; campaigns: Array<{ id: string; name: string }> },
): AppliedFilter[] {
  const without = (key: string) => {
    const rest = new URLSearchParams({ scope });
    for (const [k, v] of Object.entries(values)) if (k !== key && v !== "" && v !== false) rest.set(k, v === true ? "1" : String(v));
    return `/actions?${rest.toString()}`;
  };
  const chips: AppliedFilter[] = [];
  const add = (key: keyof QueueFilterValues, name: string, value: string) => chips.push({ key, name, value, href: without(key) });
  if (values.category) add("category", "Reply category", values.category === "unclassified" ? "Unclassified" : (REPLY_CATEGORIES.find((c) => c.key === values.category)?.label ?? values.category));
  if (values.channel) add("channel", "Channel", values.channel === "linkedin" ? "LinkedIn" : "Email");
  if (values.group) add("group", "Group", QUEUE_GROUP_LABELS[values.group as (typeof QUEUE_GROUPS)[number]]?.title ?? values.group);
  if (values.subcategoryId) add("subcategoryId", "Reply subcategory", names.subcategories.find((s) => s.id === values.subcategoryId)?.name ?? values.subcategoryId);
  if (values.campaignId) add("campaignId", "Campaign", names.campaigns.find((c) => c.id === values.campaignId)?.name ?? values.campaignId);
  if (values.dueAfter) add("dueAfter", "Due after", values.dueAfter);
  if (values.dueBefore) add("dueBefore", "Due before", values.dueBefore);
  if (values.errorsOnly) add("errorsOnly", "Errors only", "Yes");
  return chips;
}
