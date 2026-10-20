import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { lifecycleOf, type LeadFilter, type LeadSort } from "@/contexts/leads/domain/lead-filter";
import { sourceLabel } from "@/contexts/leads/domain/lead-labels";
import { humanizeToken } from "@/shared/humanize";

const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

/**
 * The people filters as a plain GET form: every control is a URL param, so the result can be bookmarked,
 * exported and read back by `parseLeadFilter`. Applying a filter goes back to page 1.
 */
export function LeadsFilterBar(props: {
  filter: LeadFilter;
  sort: LeadSort;
  size: number;
  /** How many filters of the panel are set. The search box does not count. */
  panelCount: number;
  options: { campaigns: Array<{ id: string; name: string; channel: string }>; sources: string[]; categories: string[] };
}) {
  const { filter, sort, size, options } = props;
  const { panelCount } = props;
  const panelOpen = panelCount > 0;
  return (
    <form action="/leads" className="grid gap-2" aria-label="Filter leads">
      {(sort.key !== "created" || sort.dir !== "desc") && (
        <>
          <input type="hidden" name="sort" value={sort.key} />
          <input type="hidden" name="dir" value={sort.dir} />
        </>
      )}
      {size !== 50 && <input type="hidden" name="size" value={size} />}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="q"
          type="search"
          aria-label="Search leads"
          defaultValue={filter.query ?? ""}
          placeholder="Search name, email, phone, LinkedIn, title or company"
          className="min-w-48 max-w-md flex-1"
        />
        <Button type="submit">Apply filters</Button>
      </div>
      <details open={panelOpen} className="rounded-lg border bg-muted/20 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Filters{panelOpen ? ` (${panelCount})` : ""}</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Lifecycle">
            <select name="lifecycle" defaultValue={lifecycleOf(filter) === "lead" ? "" : lifecycleOf(filter)} className={SELECT} aria-label="Lifecycle">
              {LIFECYCLE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Campaign">
            <select name="campaign" defaultValue={filter.campaign ?? ""} className={SELECT} aria-label="Campaign">
              <option value="">Any lead</option>
              <option value="any">In a campaign</option>
              <option value="none">Not in a campaign</option>
              {options.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.channel})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Not in campaign">
            <select name="notCampaign" defaultValue={filter.notInCampaign ?? ""} className={SELECT} aria-label="Not in campaign">
              <option value="">No exclusion</option>
              {options.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.channel})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Replied">
            <select name="replied" defaultValue={tri(filter.replied)} className={SELECT} aria-label="Replied">
              {TRISTATE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Has conversation">
            <select name="hasConversation" defaultValue={tri(filter.hasConversation)} className={SELECT} aria-label="Has conversation">
              {TRISTATE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Last contact from (UTC date)">
            <Input type="date" name="lastFrom" defaultValue={filter.lastContactFrom ?? ""} aria-label="Last contact from (UTC date)" />
          </Field>
          <Field label="Last contact to (UTC date)">
            <Input type="date" name="lastTo" defaultValue={filter.lastContactTo ?? ""} aria-label="Last contact to (UTC date)" />
          </Field>
          <Field label="Has email">
            <select name="email" defaultValue={tri(filter.hasEmail)} className={SELECT} aria-label="Has email">
              {TRISTATE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Has LinkedIn">
            <select name="linkedin" defaultValue={tri(filter.hasLinkedin)} className={SELECT} aria-label="Has LinkedIn">
              {TRISTATE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Do not contact">
            <select name="dnc" defaultValue={tri(filter.doNotContact)} className={SELECT} aria-label="Do not contact">
              {TRISTATE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source">
            <select name="source" defaultValue={filter.source ?? ""} className={SELECT} aria-label="Source">
              <option value="">Any source</option>
              {options.sources.map((s) => (
                <option key={s} value={s}>
                  {sourceLabel(s)}
                </option>
              ))}
              {filter.source && !options.sources.includes(filter.source) && <option value={filter.source}>{sourceLabel(filter.source)}</option>}
            </select>
          </Field>
          <Field label="Reply category">
            <select name="category" defaultValue={filter.category ?? ""} className={SELECT} aria-label="Reply category">
              <option value="">Any category</option>
              {options.categories.map((c) => (
                <option key={c} value={c}>
                  {humanizeToken(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Added from (UTC date)">
            <Input type="date" name="from" defaultValue={filter.createdFrom ?? ""} aria-label="Added from (UTC date)" />
          </Field>
          <Field label="Added to (UTC date)">
            <Input type="date" name="to" defaultValue={filter.createdTo ?? ""} aria-label="Added to (UTC date)" />
          </Field>
        </div>
      </details>
    </form>
  );
}
