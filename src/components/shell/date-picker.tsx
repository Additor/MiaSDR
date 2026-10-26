"use client";

import { CalendarIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { selectTriggerClassName } from "@/components/ui/select";
import { cn } from "@/components/ui/utils";
import { formatDay, parseDay } from "./day";

export { formatDay, parseDay } from "./day";

export interface DatePickerProps {
  /** The day as yyyy-MM-dd, or "" for none. Leave it out, with `defaultValue`, for a picker that keeps its own value. */
  value?: string;
  defaultValue?: string;
  onChange?: (day: string) => void;
  /** Renders a hidden input with the day, so a GET or POST form submits it under this name ("" when empty). */
  name?: string;
  form?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** The muted text while no day is set. */
  placeholder?: string;
  /** Offers Clear under the calendar while a day is set. */
  clearable?: boolean;
  disabled?: boolean;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * One calendar day. The trigger looks like a Select trigger and shows the day as yyyy-MM-dd; the calendar opens in a
 * popover on the menu surface. Enter, Space or ArrowDown opens it on the chosen day (or today), the arrow keys move by
 * day, Page Up and Page Down by month, Enter picks and closes, and Escape closes and returns focus to the trigger. The
 * value is a calendar date: "2026-03-08" stays 2026-03-08 in every time zone.
 */
export function DatePicker({
  value: controlled,
  defaultValue = "",
  onChange,
  name,
  form,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  placeholder = "Pick a date",
  clearable = false,
  disabled = false,
  defaultOpen = false,
  className,
}: DatePickerProps) {
  const [own, setOwn] = useState(defaultValue);
  const [open, setOpen] = useState(defaultOpen);
  const popup = useRef<HTMLDivElement>(null);
  const value = controlled ?? own;
  const day = parseDay(value);

  function set(next: string) {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" || open || disabled) return;
    event.preventDefault();
    setOpen(true);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          role="combobox"
          aria-haspopup="dialog"
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          data-slot="date-picker-trigger"
          data-size="default"
          data-placeholder={value === "" ? "" : undefined}
          onKeyDown={onTriggerKeyDown}
          className={cn(selectTriggerClassName, "max-sm:data-[size=default]:h-11", className)}
        >
          <span className={cn("flex-1 truncate text-left", day && "tabular-nums")}>{day ? value : placeholder}</span>
          <CalendarIcon aria-hidden className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          ref={popup}
          aria-label={ariaLabel ?? "Choose a date"}
          className="w-auto p-0"
          // The calendar takes focus on the chosen day, or on today when none is chosen.
          initialFocus={() => popup.current?.querySelector<HTMLElement>("button[data-day][tabindex='0']") ?? true}
        >
          <Calendar
            mode="single"
            required
            selected={day ?? undefined}
            defaultMonth={day ?? undefined}
            onSelect={(picked: Date) => {
              set(formatDay(picked));
              setOpen(false);
            }}
          />
          {clearable && value !== "" && (
            <div className="border-t p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full max-sm:h-11"
                onClick={() => {
                  set("");
                  setOpen(false);
                }}
              >
                Clear
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {name && <input type="hidden" name={name} form={form} value={value} />}
    </>
  );
}
