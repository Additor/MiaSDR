import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { QUEUE_GROUPS, QUEUE_GROUP_LABELS } from "@/contexts/conversations/actions/domain/action-queue";
import { CRM_CATEGORIES } from "@/contexts/conversations/domain/crm";
import { cn } from "@/lib/utils";
import { hasAnyFilter } from "./more-filters";

const SELECT = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm max-sm:h-11 dark:bg-input/30";

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
 * The work comes first, so every filter sits in one "Filters" disclosure that opens by itself while any filter is set.
 * Closed fields still submit with the form.
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
  const field = (label: string, control: React.ReactNode) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      {control}
    </label>
  );
  return (
    <form action="/actions" method="get" aria-label="Queue filters">
      <input type="hidden" name="scope" value={scope} />
      <details open={hasAnyFilter(values)} className="group">
        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
          Filters
          {hasAnyFilter(values) && <span className="text-xs">(in use)</span>}
          <ChevronDownIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {field(
            "Reply category",
            <select name="category" defaultValue={values.category} className={SELECT}>
              <option value="">All reply categories</option>
              {CRM_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
              <option value="unclassified">Unclassified</option>
            </select>,
          )}
          {field(
            "Channel",
            <select name="channel" defaultValue={values.channel} className={SELECT}>
              <option value="">All channels</option>
              <option value="email">Email</option>
              <option value="linkedin">LinkedIn</option>
            </select>,
          )}
          {field(
            "Group",
            <select name="group" defaultValue={values.group} className={SELECT}>
              <option value="">All groups</option>
              {QUEUE_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {QUEUE_GROUP_LABELS[g].title}
                </option>
              ))}
            </select>,
          )}
          {field(
            "Reply subcategory",
            <select name="subcategoryId" defaultValue={values.subcategoryId} className={SELECT}>
              <option value="">All reply subcategories</option>
              {subcategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>,
          )}
          {field(
            "Campaign",
            <select name="campaignId" defaultValue={values.campaignId} className={SELECT}>
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>,
          )}
          {field("Due after", <input type="date" name="dueAfter" defaultValue={values.dueAfter} className={SELECT} />)}
          {field("Due before", <input type="date" name="dueBefore" defaultValue={values.dueBefore} className={SELECT} />)}
          <label className="flex h-8 items-center gap-2 text-sm max-sm:h-11">
            <input type="checkbox" name="errorsOnly" value="1" defaultChecked={values.errorsOnly} />
            Errors only
          </label>
          <Button type="submit" size="sm" className="max-sm:h-11 max-sm:px-4">
            Apply filters
          </Button>
          {hasAnyFilter(values) && (
            <Link href={`/actions?scope=${scope}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-sm:h-11")}>
              Clear filters
            </Link>
          )}
        </div>
      </details>
    </form>
  );
}
