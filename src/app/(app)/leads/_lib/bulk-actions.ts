/**
 * What the lead list's selection bar shows. A person who ticks rows mostly adds them to a campaign, so that action
 * leads; Create deals and the delete actions sit in one overflow menu, destructive items last. The bar never shows more than
 * `MAX_VISIBLE_CONTROLS` controls, whatever the filter or the selection.
 */

export const MAX_VISIBLE_CONTROLS = 4;

export type BulkControlId = "addToCampaign" | "export" | "more" | "clear";
import type { LifecycleFilter } from "@/contexts/people/domain/lead-filter";

export type BulkMenuItemId = "selectAll" | "createDeals" | "deleteSelected" | "deleteMatching";

export interface BulkMenuItem {
  id: BulkMenuItemId;
  destructive: boolean;
}

export interface BulkActionModel {
  /** In display order: the primary action first, the quiet clear button, then the menu at the right end. */
  visible: BulkControlId[];
  /** Menu entries in order. Entries with `destructive` come last, after a separator. */
  menu: BulkMenuItem[];
}

export function bulkActionModel(input: {
  selectedCount: number;
  /** Leads that match the current filter. */
  total: number;
  filterActive: boolean;
  /** Whether "Select all matching" can still add leads (see `matchingSelection`). */
  canSelectAll: boolean;
  /** False hides both delete actions, for a role that may not delete leads. */
  canDelete?: boolean;
  /** Who the list shows. Absent means leads. */
  lifecycle?: LifecycleFilter;
}): BulkActionModel {
  const lifecycle = input.lifecycle ?? "lead";
  if (input.selectedCount === 0) return { visible: [], menu: [] };
  const menu: BulkMenuItem[] = [];
  if (input.canSelectAll) menu.push({ id: "selectAll", destructive: false });
  // A contact already has its deals on the Contact page, so a list of contacts alone offers no Create deals.
  if (lifecycle !== "contact") menu.push({ id: "createDeals", destructive: false });
  if (input.canDelete !== false) {
    menu.push({ id: "deleteSelected", destructive: true });
    // Delete all matching needs a filter (the API refuses an empty one) and leads only: the API answers 422 for any other
    // lifecycle, because a contact has history and is never deleted.
    if (input.filterActive && input.total > 0 && lifecycle === "lead") menu.push({ id: "deleteMatching", destructive: true });
  }
  const visible: BulkControlId[] = ["addToCampaign", "export", "clear"];
  if (menu.length > 0) visible.push("more");
  return { visible, menu };
}

/** Esc clears the selection when something is ticked and no inner widget (a menu, a dialog) already used the key. */
export function clearsSelectionOnKey(input: { key: string; selectedCount: number; defaultPrevented: boolean }): boolean {
  return input.key === "Escape" && input.selectedCount > 0 && !input.defaultPrevented;
}
