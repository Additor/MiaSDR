"use client";

import { getCountries } from "libphonenumber-js";
import { useMemo } from "react";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";

const NONE = "";

/** "South Korea (KR)" for "KR", from the browser's region names in English. */
function countryLabel(names: Intl.DisplayNames, code: string): string {
  if (code === NONE) return "No default";
  return `${names.of(code) ?? code} (${code})`;
}

/**
 * The countries a phone number can belong to, by name, with "No default" first. Type a name or a code to narrow the
 * list. The value is the two-letter code, or "" for none.
 */
export function CountrySelect({ id, value, onValueChange, disabled, describedBy }: { id: string; value: string; onValueChange: (code: string) => void; disabled?: boolean; describedBy?: string }) {
  const names = useMemo(() => new Intl.DisplayNames(["en"], { type: "region" }), []);
  const items = useMemo(() => [NONE, ...[...getCountries()].sort((a, b) => countryLabel(names, a).localeCompare(countryLabel(names, b)))], [names]);
  return (
    <Combobox items={items} value={value} onValueChange={(next) => typeof next === "string" && onValueChange(next)} itemToStringLabel={(code: string) => countryLabel(names, code)} disabled={disabled} autoHighlight>
      <ComboboxInput id={id} placeholder="Search countries" disabled={disabled} aria-describedby={describedBy} className="w-full max-w-sm" />
      <ComboboxContent>
        <ComboboxEmpty>No country matches.</ComboboxEmpty>
        <ComboboxList>
          {(code: string) => (
            <ComboboxItem key={code || "none"} value={code}>
              {countryLabel(names, code)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
