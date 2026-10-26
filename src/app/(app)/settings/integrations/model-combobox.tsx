"use client";

import { useMemo } from "react";
import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList } from "@/components/ui/combobox";

interface ModelGroup {
  /** Heading text; empty for the group that needs none. */
  label: string;
  items: string[];
}

/**
 * Groups gateway ids by the vendor before the slash (`openai/gpt-6` under "openai"), so a list of hundreds reads as a
 * few dozen headings. Direct Anthropic ids have no slash and share one group. `pinned` (the default entry, the saved
 * model) leads the list without a heading.
 */
export function groupModels(ids: readonly string[], pinned: readonly string[]): ModelGroup[] {
  const byVendor = new Map<string, string[]>();
  for (const id of ids) {
    if (pinned.includes(id)) continue;
    const slash = id.indexOf("/");
    const vendor = slash > 0 ? id.slice(0, slash) : "";
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), id]);
  }
  const groups = [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, items]) => ({ label, items }));
  if (pinned.length === 0) return groups;
  // Below the pinned entries, ids without a vendor need a heading so the two groups read apart.
  return [{ label: "", items: [...pinned] }, ...groups.map((g) => (g.label ? g : { ...g, label: "Other models" }))];
}

/**
 * The model picker: type to filter, arrow keys to move, Enter to pick. A pasted id that matches a listed model selects
 * it; the server checks the choice against the provider's list again on save.
 */
export function ModelCombobox(props: {
  id: string;
  ids: readonly string[];
  pinned: readonly string[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  labelOf: (value: string) => string;
  disabled?: boolean;
}) {
  const { id, ids, pinned, value, onValueChange, labelOf, disabled } = props;
  const groups = useMemo(() => groupModels(ids, pinned), [ids, pinned]);
  return (
    <Combobox items={groups} value={value} onValueChange={(next) => onValueChange(next as string | null)} itemToStringLabel={(v: string) => labelOf(v)} autoHighlight disabled={disabled}>
      <ComboboxInput id={id} placeholder="Pick a model" disabled={disabled} className="w-full max-w-sm" />
      <ComboboxContent>
        <ComboboxEmpty>No listed model matches.</ComboboxEmpty>
        <ComboboxList>
          {(group: ModelGroup) => (
            <ComboboxGroup key={group.label || "pinned"} items={group.items} className="pb-1 last:pb-0">
              {group.label && <ComboboxLabel>{group.label}</ComboboxLabel>}
              <ComboboxCollection>
                {(item: string) => (
                  <ComboboxItem key={item} value={item}>
                    <span className="truncate">{labelOf(item)}</span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
