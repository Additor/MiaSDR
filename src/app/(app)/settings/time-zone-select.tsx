"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The time zone picker that Organization and the mailbox hours dialog share. */
export function TimeZoneSelect({ id, zones, value, onValueChange, disabled }: { id: string; zones: string[]; value: string; onValueChange: (zone: string) => void; disabled?: boolean }) {
  const items = zones.map((zone) => ({ value: zone, label: zone }));
  return (
    <Select items={items} value={value} onValueChange={(v) => v && onValueChange(v)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full max-w-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
