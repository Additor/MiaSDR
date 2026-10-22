"use client";

import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TimeZoneSelect } from "./time-zone-select";

/** Stored day keys run Sunday "0" to Saturday "6"; the picker shows the week from Monday. */
const DAYS = [
  { key: "1", label: "Mon", name: "Monday" },
  { key: "2", label: "Tue", name: "Tuesday" },
  { key: "3", label: "Wed", name: "Wednesday" },
  { key: "4", label: "Thu", name: "Thursday" },
  { key: "5", label: "Fri", name: "Friday" },
  { key: "6", label: "Sat", name: "Saturday" },
  { key: "0", label: "Sun", name: "Sunday" },
];

export interface StoredHours {
  timeZone: string;
  days: Record<string, Array<{ start: string; end: string }>>;
}

/** One window on the chosen days: what the hours fields edit. */
export interface HoursDraft {
  timeZone: string;
  days: string[];
  start: string;
  end: string;
}

export function hoursDraft(stored: StoredHours | null, fallbackZone: string): HoursDraft {
  const window = stored ? Object.values(stored.days).find((w) => w.length > 0)?.[0] : undefined;
  return {
    timeZone: stored?.timeZone ?? fallbackZone,
    days: stored ? DAYS.map((d) => d.key).filter((key) => (stored.days[key]?.length ?? 0) > 0) : ["1", "2", "3", "4", "5"],
    start: window?.start ?? "09:00",
    end: window?.end ?? "18:00",
  };
}

export const toStoredHours = (draft: HoursDraft): StoredHours => ({ timeZone: draft.timeZone, days: Object.fromEntries(draft.days.map((d) => [d, [{ start: draft.start, end: draft.end }]])) });

export const sameHours = (a: HoursDraft, b: HoursDraft) => a.timeZone === b.timeZone && a.start === b.start && a.end === b.end && [...a.days].sort().join() === [...b.days].sort().join();

/** "Mon to Fri, 09:00 to 18:00, Asia/Seoul" for a row. Runs of days collapse; scattered days list by name. */
export function hoursSummary(draft: HoursDraft): string {
  const order = DAYS.map((d) => d.key).filter((key) => draft.days.includes(key));
  if (order.length === 0) return "No sending days";
  const indexes = order.map((key) => DAYS.findIndex((d) => d.key === key));
  const run = indexes.every((index, i) => i === 0 || index === indexes[i - 1] + 1);
  const label = (key: string) => DAYS.find((d) => d.key === key)!.label;
  const days = order.length === 7 ? "Every day" : run && order.length > 2 ? `${label(order[0])} to ${label(order[order.length - 1])}` : order.map(label).join(", ");
  return `${days}, ${draft.start} to ${draft.end}, ${draft.timeZone}`;
}

/** Time zone, sending days and one window. `id` prefixes the field ids, so two accounts on one page do not collide. */
export function WorkingHoursFields({ id, value, onChange, zones, disabled }: { id: string; value: HoursDraft; onChange: (next: HoursDraft) => void; zones: string[]; disabled?: boolean }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-tz`}>Time zone</FieldLabel>
        <TimeZoneSelect id={`${id}-tz`} zones={zones} value={value.timeZone} onValueChange={(timeZone) => onChange({ ...value, timeZone })} disabled={disabled} />
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Send on</FieldLegend>
        <ToggleGroup multiple variant="outline" size="sm" spacing={1} value={value.days} onValueChange={(days) => onChange({ ...value, days: days as string[] })} disabled={disabled} aria-label="Sending days" className="flex-wrap">
          {DAYS.map((d) => (
            <ToggleGroupItem key={d.key} value={d.key} aria-label={d.name} className="min-w-11 data-pressed:border-foreground/40 data-pressed:bg-muted data-pressed:font-semibold">
              {d.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
      <div className="flex flex-wrap items-end gap-group">
        <Field className="w-auto">
          <FieldLabel htmlFor={`${id}-start`}>From</FieldLabel>
          <Input id={`${id}-start`} type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} required disabled={disabled} className="w-32" />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor={`${id}-end`}>Until</FieldLabel>
          <Input id={`${id}-end`} type="time" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} required disabled={disabled} className="w-32" />
        </Field>
      </div>
    </>
  );
}
