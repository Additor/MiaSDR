"use client";

import { Checkbox } from "@/components/ui/checkbox";

export interface SenderOption {
  id: string;
  label: string;
  connected: boolean;
}

/** Ticks the mailboxes or accounts a campaign sends from. Nothing ticked means every connected one. */
export function SenderPicker({ options, value, onChange, noun, disabled }: { options: SenderOption[]; value: string[]; onChange: (ids: string[]) => void; noun: string; disabled?: boolean }) {
  if (options.length === 0) return <p className="text-sm text-muted-foreground">No {noun} is connected yet.</p>;
  return (
    <fieldset className="stack-field" disabled={disabled}>
      <legend className="sr-only">Send from</legend>
      {options.map((option) => {
        const checked = value.includes(option.id);
        // A connected sender can be ticked. A sender that dropped off stays tickable only to untick it.
        return (
          <label key={option.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={checked}
              disabled={!option.connected && !checked}
              onCheckedChange={(next) => onChange(next === true ? [...value, option.id] : value.filter((id) => id !== option.id))}
            />
            <span>{option.label}</span>
            {!option.connected && <span className="text-xs text-destructive">not connected</span>}
          </label>
        );
      })}
      <p className="text-xs text-muted-foreground">{value.length === 0 ? `Leave all unticked to send from every connected ${noun}.` : `Only the ticked ${noun}s send for this campaign.`}</p>
    </fieldset>
  );
}
