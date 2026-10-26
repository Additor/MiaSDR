"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/components/ui/utils";

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The times a `TimeSelect` offers: every 30 minutes from 00:00 to 23:30, then 23:59 with `endOfDay`, and `current` in its
 * place when it is a valid HH:mm off the step, so a saved 09:15 shows and saves unchanged.
 */
export function timeOptions(current: string, endOfDay = false): string[] {
  const times = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
  if (endOfDay) times.push("23:59");
  if (HH_MM.test(current) && !times.includes(current)) times.push(current);
  return times.sort();
}

/**
 * A time of day as HH:mm (24-hour) in the app's Select, every 30 minutes. `endOfDay` adds 23:59 for the end of a window
 * that runs to midnight. 44px tall on a phone.
 */
export function TimeSelect({
  id,
  value,
  onChange,
  endOfDay = false,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (time: string) => void;
  endOfDay?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const items = timeOptions(value, endOfDay).map((t) => ({ value: t, label: t }));
  return (
    <Select items={items} value={value} onValueChange={(v) => v !== null && onChange(v)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("w-32 tabular-nums max-sm:data-[size=default]:h-11", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="tabular-nums">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
