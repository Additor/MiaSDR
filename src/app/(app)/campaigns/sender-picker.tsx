"use client";

import { TriangleAlertIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { cn } from "@/components/ui/utils";

export interface SenderOption {
  id: string;
  label: string;
  connected: boolean;
}

/**
 * Ticks the mailboxes or accounts a campaign sends from. Nothing ticked means every connected one. The legend reads
 * "Send from"; `legend` shows it where no section heading names the choice (the New campaign dialog).
 */
export function SenderPicker({
  options,
  value,
  onChange,
  noun,
  disabled,
  legend = false,
}: {
  options: SenderOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  noun: string;
  disabled?: boolean;
  legend?: boolean;
}) {
  return (
    <FieldSet className="gap-field" disabled={disabled}>
      <FieldLegend variant="label" className={cn(!legend && "sr-only")}>
        Send from
      </FieldLegend>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {noun} is connected yet.</p>
      ) : (
        <>
          {options.map((option) => {
            const checked = value.includes(option.id);
            const id = `sender-${option.id}`;
            // A connected sender can be ticked. A sender that dropped off stays tickable only to untick it.
            return (
              <Field key={option.id} orientation="horizontal" className="w-auto">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={!option.connected && !checked}
                  onCheckedChange={(next) => onChange(next === true ? [...value, option.id] : value.filter((sender) => sender !== option.id))}
                />
                <FieldLabel htmlFor={id} className="font-normal">
                  {option.label}
                  {!option.connected && (
                    // A sender that dropped off is a degraded state: the warning icon and a muted label, never red.
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
                      not connected
                    </span>
                  )}
                </FieldLabel>
              </Field>
            );
          })}
          <FieldDescription className="text-xs">{value.length === 0 ? `Leave all unticked to send from every connected ${noun}.` : `Only the ticked ${noun}s send for this campaign.`}</FieldDescription>
        </>
      )}
    </FieldSet>
  );
}
