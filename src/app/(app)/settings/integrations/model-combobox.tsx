"use client";

import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";

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
    <Combobox.Root items={groups} value={value} onValueChange={(next) => onValueChange(next as string | null)} itemToStringLabel={(v: string) => labelOf(v)} autoHighlight disabled={disabled}>
      <Combobox.InputGroup className="relative w-full max-w-sm">
        <Combobox.Input
          id={id}
          placeholder="Pick a model"
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
        />
        <Combobox.Trigger aria-label="Show models" className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground disabled:opacity-50">
          <ChevronDownIcon aria-hidden className="size-4" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50">
          <Combobox.Popup className="w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[opacity,scale] duration-(--duration-menu) ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <Combobox.Empty>
              <p className="px-2.5 py-2 text-sm text-muted-foreground">No listed model matches.</p>
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(22.5rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-0 data-empty:p-0">
              {(group: ModelGroup) => (
                <Combobox.Group key={group.label || "pinned"} items={group.items} className="pb-1 last:pb-0">
                  {group.label && <Combobox.GroupLabel className="px-1.5 py-1 text-xs text-muted-foreground">{group.label}</Combobox.GroupLabel>}
                  <Combobox.Collection>
                    {(item: string) => (
                      <Combobox.Item
                        key={item}
                        value={item}
                        className="relative flex w-full cursor-default items-center rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                      >
                        <span className="truncate">{labelOf(item)}</span>
                        <Combobox.ItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                          <CheckIcon aria-hidden className="size-4" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
