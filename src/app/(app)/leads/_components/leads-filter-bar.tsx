import type { ReactNode } from "react";
import { DateRangeField, FilterSection, SelectField, TristateField } from "@/components/shell/filter-fields";
import { FilterPopover } from "@/components/shell/filter-popover";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { SearchField } from "@/components/shell/search-field";
import { lifecycleOf, type LeadFilter, type LeadSort } from "@/contexts/people/domain/lead-filter";
import { sourceLabel } from "@/contexts/people/domain/lead-labels";
import { humanizeToken } from "@/shared/humanize";

/** Lifecycle choices. "Leads" posts nothing, so the default stays out of the URL. */
const LIFECYCLE = [
  { value: "", label: "Leads" },
  { value: "contact", label: "Contacts" },
  { value: "all", label: "Leads and contacts" },
];

/**
 * The people filters as a plain GET form: every control is a URL param, so the result can be bookmarked,
 * exported and read back by `parseLeadFilter`. Search and the Filters popover share the form, so Enter in the search
 * keeps the panel's filters. Applying a filter goes back to page 1.
 */
export function LeadsFilterBar(props: {
  filter: LeadFilter;
  sort: LeadSort;
  size: number;
  /** How many filters of the panel are set. The search box does not count. */
  panelCount: number;
  /** List options at the right of the toolbar. */
  end?: ReactNode;
  options: { campaigns: Array<{ id: string; name: string; channel: string }>; sources: string[]; categories: string[] };
}) {
  const { filter, sort, size, options, panelCount, end } = props;
  const campaigns = options.campaigns.map((c) => ({ value: c.id, label: `${c.name} (${c.channel})` }));
  const sources = filter.source && !options.sources.includes(filter.source) ? [...options.sources, filter.source] : options.sources;
  return (
    <form action="/leads" aria-label="Filter leads">
      {(sort.key !== "created" || sort.dir !== "desc") && (
        <>
          <input type="hidden" name="sort" value={sort.key} />
          <input type="hidden" name="dir" value={sort.dir} />
        </>
      )}
      {size !== 50 && <input type="hidden" name="size" value={size} />}
      <ListToolbar
        end={end}
        filters={
          <FilterPopover count={panelCount}>
            <FilterSection title="Outreach">
              <SelectField label="Lifecycle" name="lifecycle" defaultValue={lifecycleOf(filter) === "lead" ? "" : lifecycleOf(filter)} options={LIFECYCLE} />
              <SelectField
                label="Campaign"
                name="campaign"
                defaultValue={filter.campaign ?? ""}
                options={[{ value: "", label: "Any lead" }, { value: "any", label: "In a campaign" }, { value: "none", label: "Not in a campaign" }, ...campaigns]}
              />
              <SelectField label="Not in campaign" name="notCampaign" defaultValue={filter.notInCampaign ?? ""} options={[{ value: "", label: "No exclusion" }, ...campaigns]} />
              <TristateField label="Replied" name="replied" value={filter.replied} />
              <TristateField label="Has conversation" name="hasConversation" value={filter.hasConversation} />
              <SelectField label="Reply group" name="category" defaultValue={filter.category ?? ""} options={[{ value: "", label: "Any group" }, ...options.categories.map((c) => ({ value: c, label: humanizeToken(c) }))]} />
            </FilterSection>
            <FilterSection title="Reachability">
              <TristateField label="Has email" name="email" value={filter.hasEmail} />
              <TristateField label="Has LinkedIn" name="linkedin" value={filter.hasLinkedin} />
              <TristateField label="Do not contact" name="dnc" value={filter.doNotContact} />
            </FilterSection>
            <FilterSection title="Source and dates (UTC)">
              <SelectField label="Source" name="source" defaultValue={filter.source ?? ""} options={[{ value: "", label: "Any source" }, ...sources.map((s) => ({ value: s, label: sourceLabel(s) }))]} />
              <DateRangeField label="Added" from={{ name: "from", value: filter.createdFrom ?? "" }} to={{ name: "to", value: filter.createdTo ?? "" }} />
              <DateRangeField label="Last contact" from={{ name: "lastFrom", value: filter.lastContactFrom ?? "" }} to={{ name: "lastTo", value: filter.lastContactTo ?? "" }} />
            </FilterSection>
          </FilterPopover>
        }
      >
        <SearchField label="Search leads" defaultValue={filter.query ?? ""} placeholder="Search name, email, phone, LinkedIn, title or company" />
      </ListToolbar>
    </form>
  );
}
