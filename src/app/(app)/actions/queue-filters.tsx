import { FILTER_SELECT, FilterField, FilterPanel, type ActiveFilterChip } from "@/components/shell/filter-panel";
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
 * A plain GET form: the filters live in the URL, so a filtered queue can be linked and works before the page hydrates.
 * The page passes it to the toolbar's Filters button, and the chips under the toolbar show what applies.
 */
export function QueueFilters({
  values,
  scope,
  subcategories,
  campaigns,
}: {
  values: QueueFilterValues;
  /** The scope chip in view. The form carries it, so applying filters keeps whose work is shown. */
  scope: string;
  subcategories: Array<{ id: string; name: string; categoryKey: string }>;
  campaigns: Array<{ id: string; name: string }>;
}) {
  return (
    <form action="/actions" method="get" aria-label="Queue filters">
      <input type="hidden" name="scope" value={scope} />
      <FilterPanel>
        <FilterField label="Reply category">
          <select name="category" defaultValue={values.category} className={FILTER_SELECT}>
            <option value="">All reply categories</option>
            {REPLY_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
            <option value="unclassified">Unclassified</option>
          </select>
        </FilterField>
        <FilterField label="Channel">
          <select name="channel" defaultValue={values.channel} className={FILTER_SELECT}>
            <option value="">All channels</option>
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn</option>
          </select>
        </FilterField>
        <FilterField label="Group">
          <select name="group" defaultValue={values.group} className={FILTER_SELECT}>
            <option value="">All groups</option>
            {QUEUE_GROUPS.map((g) => (
              <option key={g} value={g}>
                {QUEUE_GROUP_LABELS[g].title}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Reply subcategory">
          <select name="subcategoryId" defaultValue={values.subcategoryId} className={FILTER_SELECT}>
            <option value="">All reply subcategories</option>
            {subcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Campaign">
          <select name="campaignId" defaultValue={values.campaignId} className={FILTER_SELECT}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Due after">
          <input type="date" name="dueAfter" defaultValue={values.dueAfter} className={FILTER_SELECT} />
        </FilterField>
        <FilterField label="Due before">
          <input type="date" name="dueBefore" defaultValue={values.dueBefore} className={FILTER_SELECT} />
        </FilterField>
        <label className="flex h-8 items-center gap-2 self-end text-sm text-foreground max-sm:h-11">
          <input type="checkbox" name="errorsOnly" value="1" defaultChecked={values.errorsOnly} />
          Errors only
        </label>
      </FilterPanel>
    </form>
  );
}

/** The queue's filters in force as chips, each a link to the queue without it. */
export function queueFilterChips(
  values: QueueFilterValues,
  scope: string,
  names: { subcategories: Array<{ id: string; name: string }>; campaigns: Array<{ id: string; name: string }> },
): ActiveFilterChip[] {
  const without = (key: string) => {
    const rest = new URLSearchParams({ scope });
    for (const [k, v] of Object.entries(values)) if (k !== key && v !== "" && v !== false) rest.set(k, v === true ? "1" : String(v));
    return `/actions?${rest.toString()}`;
  };
  const chips: ActiveFilterChip[] = [];
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
