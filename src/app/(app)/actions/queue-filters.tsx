import type { AppliedFilter } from "@/components/shell/filter-chip";
import { CheckField, DateRangeField, SelectField } from "@/components/shell/filter-fields";
import { FilterPopover } from "@/components/shell/filter-popover";
import { QUEUE_GROUPS, QUEUE_GROUP_LABELS } from "@/contexts/conversations/actions/domain/action-queue";
import { REPLY_TYPE_GROUPS, groupLabel } from "@/contexts/conversations/domain/reply-handling";
import { ambiguousTypeNames, typeLabel } from "./type-label";

export interface QueueFilterValues {
  category: string;
  channel: string;
  group: string;
  replyTypeId: string;
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

/** The record has no reply type yet. The URL keeps its old value, `category=unclassified`. */
const NO_TYPE = { value: "unclassified", label: "No type yet" };

const typeOptions = (types: Array<{ id: string; name: string; groupKey: string }>) => {
  const ambiguous = ambiguousTypeNames(types);
  return types.map((t) => ({ value: t.id, label: typeLabel(t.name, t.groupKey, ambiguous) ?? t.name }));
};

/**
 * The Filters popover as its own GET form: the filters live in the URL, so a filtered queue can be linked. The chips
 * under the toolbar show what applies.
 */
export function QueueFilters({
  values,
  scope,
  count,
  replyTypes,
  campaigns,
}: {
  values: QueueFilterValues;
  /** The scope chip in view. The form carries it, so applying filters keeps whose work is shown. */
  scope: string;
  count: number;
  replyTypes: Array<{ id: string; name: string; groupKey: string }>;
  campaigns: Array<{ id: string; name: string }>;
}) {
  return (
    <FilterPopover count={count} form={{ action: "/actions", label: "Queue filters", hidden: <input type="hidden" name="scope" value={scope} /> }}>
      <SelectField label="Action" name="group" defaultValue={values.group} options={[{ value: "", label: "All actions" }, ...QUEUE_GROUPS.map((g) => ({ value: g, label: QUEUE_GROUP_LABELS[g].title }))]} />
      <SelectField label="Channel" name="channel" defaultValue={values.channel} options={CHANNELS} />
      <SelectField label="Campaign" name="campaignId" defaultValue={values.campaignId} options={[{ value: "", label: "All campaigns" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
      <SelectField label="Group" name="category" defaultValue={values.category} options={[{ value: "", label: "All groups" }, ...REPLY_TYPE_GROUPS.map((c) => ({ value: c.key, label: c.label })), NO_TYPE]} />
      <SelectField label="Reply type" name="replyTypeId" defaultValue={values.replyTypeId} options={[{ value: "", label: "All reply types" }, ...typeOptions(replyTypes)]} />
      <DateRangeField label="Due" from={{ name: "dueAfter", value: values.dueAfter }} to={{ name: "dueBefore", value: values.dueBefore }} />
      <CheckField label="Errors only" name="errorsOnly" defaultChecked={values.errorsOnly} />
    </FilterPopover>
  );
}

/** The queue's filters in force as chips, each a link to the queue without it. */
export function queueFilterChips(
  values: QueueFilterValues,
  scope: string,
  names: { replyTypes: Array<{ id: string; name: string; groupKey: string }>; campaigns: Array<{ id: string; name: string }> },
): AppliedFilter[] {
  const without = (key: string) => {
    const rest = new URLSearchParams({ scope });
    for (const [k, v] of Object.entries(values)) if (k !== key && v !== "" && v !== false) rest.set(k, v === true ? "1" : String(v));
    return `/actions?${rest.toString()}`;
  };
  const chips: AppliedFilter[] = [];
  const add = (key: keyof QueueFilterValues, name: string, value: string) => chips.push({ key, name, value, href: without(key) });
  if (values.category) add("category", "Group", values.category === NO_TYPE.value ? NO_TYPE.label : REPLY_TYPE_GROUPS.some((c) => c.key === values.category) ? groupLabel(values.category) : values.category);
  if (values.channel) add("channel", "Channel", values.channel === "linkedin" ? "LinkedIn" : "Email");
  if (values.group) add("group", "Action", QUEUE_GROUP_LABELS[values.group as (typeof QUEUE_GROUPS)[number]]?.title ?? values.group);
  if (values.replyTypeId) add("replyTypeId", "Reply type", typeOptions(names.replyTypes).find((o) => o.value === values.replyTypeId)?.label ?? values.replyTypeId);
  if (values.campaignId) add("campaignId", "Campaign", names.campaigns.find((c) => c.id === values.campaignId)?.name ?? values.campaignId);
  if (values.dueAfter) add("dueAfter", "Due after", values.dueAfter);
  if (values.dueBefore) add("dueBefore", "Due before", values.dueBefore);
  if (values.errorsOnly) add("errorsOnly", "Errors only", "Yes");
  return chips;
}
