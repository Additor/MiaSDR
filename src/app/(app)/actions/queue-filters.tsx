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

const CHANNELS = [
  { value: "", label: "All channels" },
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
];

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
      <SelectField label="Group" name="group" defaultValue={values.group} options={[{ value: "", label: "All groups" }, ...QUEUE_GROUPS.map((g) => ({ value: g, label: QUEUE_GROUP_LABELS[g].title }))]} />
      <SelectField label="Channel" name="channel" defaultValue={values.channel} options={CHANNELS} />
      <SelectField label="Campaign" name="campaignId" defaultValue={values.campaignId} options={[{ value: "", label: "All campaigns" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
      <SelectField
        label="Reply category"
        name="category"
        defaultValue={values.category}
        options={[{ value: "", label: "All reply categories" }, ...REPLY_CATEGORIES.map((c) => ({ value: c.key, label: c.label })), { value: "unclassified", label: "Unclassified" }]}
      />
      <SelectField label="Reply subcategory" name="subcategoryId" defaultValue={values.subcategoryId} options={[{ value: "", label: "All reply subcategories" }, ...subcategories.map((s) => ({ value: s.id, label: s.name }))]} />
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
