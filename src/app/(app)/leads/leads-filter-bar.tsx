import type { ReactNode } from "react";
import { FILTER_SELECT, FilterField, FilterPanel } from "@/components/shell/filter-panel";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { SearchField } from "@/components/shell/search-field";
import { Input } from "@/components/ui/input";
import { lifecycleOf, type LeadFilter, type LeadSort } from "@/contexts/leads/domain/lead-filter";
import { sourceLabel } from "@/contexts/leads/domain/lead-labels";
import { humanizeToken } from "@/shared/humanize";

const TRISTATE = [
  { value: "", label: "Any" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

/** Lifecycle choices. "Leads" posts nothing, so the default stays out of the URL. */
const LIFECYCLE = [
  { value: "", label: "Leads" },
  { value: "contact", label: "Contacts" },
  { value: "all", label: "Leads and contacts" },
];

const tri = (value: boolean | undefined) => (value === undefined ? "" : value ? "yes" : "no");

/**
 * The people filters as a plain GET form: every control is a URL param, so the result can be bookmarked,
 * exported and read back by `parseLeadFilter`. Search and the Filters panel share the form, so Enter in the search
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
        filters={{
          count: panelCount,
          panel: (
            <FilterPanel>
              <FilterField label="Lifecycle">
                <select name="lifecycle" defaultValue={lifecycleOf(filter) === "lead" ? "" : lifecycleOf(filter)} className={FILTER_SELECT} aria-label="Lifecycle">
                  {LIFECYCLE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Campaign">
                <select name="campaign" defaultValue={filter.campaign ?? ""} className={FILTER_SELECT} aria-label="Campaign">
                  <option value="">Any lead</option>
                  <option value="any">In a campaign</option>
                  <option value="none">Not in a campaign</option>
                  {options.campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.channel})
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Not in campaign">
                <select name="notCampaign" defaultValue={filter.notInCampaign ?? ""} className={FILTER_SELECT} aria-label="Not in campaign">
                  <option value="">No exclusion</option>
                  {options.campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.channel})
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Replied">
                <select name="replied" defaultValue={tri(filter.replied)} className={FILTER_SELECT} aria-label="Replied">
                  {TRISTATE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Has conversation">
                <select name="hasConversation" defaultValue={tri(filter.hasConversation)} className={FILTER_SELECT} aria-label="Has conversation">
                  {TRISTATE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Last contact from (UTC date)">
                <Input className="max-sm:h-11" type="date" name="lastFrom" defaultValue={filter.lastContactFrom ?? ""} aria-label="Last contact from (UTC date)" />
              </FilterField>
              <FilterField label="Last contact to (UTC date)">
                <Input className="max-sm:h-11" type="date" name="lastTo" defaultValue={filter.lastContactTo ?? ""} aria-label="Last contact to (UTC date)" />
              </FilterField>
              <FilterField label="Has email">
                <select name="email" defaultValue={tri(filter.hasEmail)} className={FILTER_SELECT} aria-label="Has email">
                  {TRISTATE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Has LinkedIn">
                <select name="linkedin" defaultValue={tri(filter.hasLinkedin)} className={FILTER_SELECT} aria-label="Has LinkedIn">
                  {TRISTATE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Do not contact">
                <select name="dnc" defaultValue={tri(filter.doNotContact)} className={FILTER_SELECT} aria-label="Do not contact">
                  {TRISTATE.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Source">
                <select name="source" defaultValue={filter.source ?? ""} className={FILTER_SELECT} aria-label="Source">
                  <option value="">Any source</option>
                  {options.sources.map((s) => (
                    <option key={s} value={s}>
                      {sourceLabel(s)}
                    </option>
                  ))}
                  {filter.source && !options.sources.includes(filter.source) && <option value={filter.source}>{sourceLabel(filter.source)}</option>}
                </select>
              </FilterField>
              <FilterField label="Reply category">
                <select name="category" defaultValue={filter.category ?? ""} className={FILTER_SELECT} aria-label="Reply category">
                  <option value="">Any category</option>
                  {options.categories.map((c) => (
                    <option key={c} value={c}>
                      {humanizeToken(c)}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Added from (UTC date)">
                <Input className="max-sm:h-11" type="date" name="from" defaultValue={filter.createdFrom ?? ""} aria-label="Added from (UTC date)" />
              </FilterField>
              <FilterField label="Added to (UTC date)">
                <Input className="max-sm:h-11" type="date" name="to" defaultValue={filter.createdTo ?? ""} aria-label="Added to (UTC date)" />
              </FilterField>
            </FilterPanel>
          ),
        }}
      >
        <SearchField label="Search leads" defaultValue={filter.query ?? ""} placeholder="Search name, email, phone, LinkedIn, title or company" />
      </ListToolbar>
    </form>
  );
}
