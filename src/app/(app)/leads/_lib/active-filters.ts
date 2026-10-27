import { DEFAULT_LIFECYCLE, type LeadFilter, type LifecycleFilter } from "@/contexts/people/domain/lead-filter";
import { sourceLabel } from "@/contexts/people/domain/lead-labels";
import { humanizeToken } from "@/shared/humanize";

/** One applied filter, shown as a removable chip above the list. */
export interface FilterChip {
  key: string;
  /** The filter's name, as it reads in the panel. */
  name: string;
  /** What it is set to. */
  value: string;
  /** The filter without this one. */
  without: LeadFilter;
}

interface Options {
  campaigns: ReadonlyArray<{ id: string; name: string }>;
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");

/** The words of the Lifecycle filter, as the panel offers them. */
export const LIFECYCLE_LABELS: Record<LifecycleFilter, string> = { lead: "Leads", contact: "Contacts", all: "Leads and contacts" };

/**
 * The applied filters in panel order, search first. `ids` is not a filter a person sets, so it gets no chip. The default
 * lifecycle (leads) gets none either: the list shows leads unless the person picks Contacts or both.
 */
export function activeFilterChips(filter: LeadFilter, options: Options): FilterChip[] {
  const campaignName = (id: string) => options.campaigns.find((c) => c.id === id)?.name ?? "Unknown campaign";
  const chips: FilterChip[] = [];
  const add = (key: string, name: string, value: string, clear: Partial<LeadFilter>) => chips.push({ key, name, value, without: { ...filter, ...clear } });

  if (filter.query?.trim()) add("query", "Search", filter.query, { query: undefined });
  if (filter.lifecycle && filter.lifecycle !== DEFAULT_LIFECYCLE) add("lifecycle", "Lifecycle", LIFECYCLE_LABELS[filter.lifecycle], { lifecycle: undefined });
  if (filter.campaign) {
    const value = filter.campaign === "any" ? "In a campaign" : filter.campaign === "none" ? "Not in a campaign" : campaignName(filter.campaign);
    add("campaign", "Campaign", value, { campaign: undefined });
  }
  if (filter.notInCampaign) add("notCampaign", "Not in campaign", campaignName(filter.notInCampaign), { notInCampaign: undefined });
  if (filter.replied !== undefined) add("replied", "Replied", yesNo(filter.replied), { replied: undefined });
  if (filter.hasConversation !== undefined) add("hasConversation", "Has conversation", yesNo(filter.hasConversation), { hasConversation: undefined });
  if (filter.lastContactFrom) add("lastFrom", "Last contact from", filter.lastContactFrom, { lastContactFrom: undefined });
  if (filter.lastContactTo) add("lastTo", "Last contact to", filter.lastContactTo, { lastContactTo: undefined });
  if (filter.hasEmail !== undefined) add("email", "Has email", yesNo(filter.hasEmail), { hasEmail: undefined });
  if (filter.hasLinkedin !== undefined) add("linkedin", "Has LinkedIn", yesNo(filter.hasLinkedin), { hasLinkedin: undefined });
  if (filter.doNotContact !== undefined) add("dnc", "Do not contact", yesNo(filter.doNotContact), { doNotContact: undefined });
  if (filter.source) add("source", "Source", sourceLabel(filter.source), { source: undefined });
  if (filter.category) add("category", "Reply group", humanizeToken(filter.category), { category: undefined });
  if (filter.createdFrom) add("from", "Added from", filter.createdFrom, { createdFrom: undefined });
  if (filter.createdTo) add("to", "Added to", filter.createdTo, { createdTo: undefined });
  return chips;
}

/** How many filters in the panel are set. The search box has its own input, so it does not count. */
export function panelFilterCount(chips: readonly FilterChip[]): number {
  return chips.filter((chip) => chip.key !== "query").length;
}
