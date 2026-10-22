"use client";

import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";

/**
 * The time zone picker that Organization, the mailbox hours and the LinkedIn hours share. About 400 zones, so it is a
 * combobox: type part of a city or region ("Seoul", "Europe") to narrow the list.
 */
export function TimeZoneSelect({ id, zones, value, onValueChange, disabled }: { id: string; zones: string[]; value: string; onValueChange: (zone: string) => void; disabled?: boolean }) {
  const items = zones.includes(value) ? zones : [value, ...zones];
  return (
    <Combobox items={items} value={value} onValueChange={(next) => typeof next === "string" && onValueChange(next)} disabled={disabled} autoHighlight>
      <ComboboxInput id={id} placeholder="Search time zones" disabled={disabled} className="w-full max-w-sm" />
      <ComboboxContent>
        <ComboboxEmpty>No time zone matches.</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => (
            <ComboboxItem key={zone} value={zone}>
              {zone}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
