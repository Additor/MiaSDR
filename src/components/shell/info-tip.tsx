"use client";

import { InfoIcon, KeyboardIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TouchTip } from "./touch-tip";

/**
 * A small info mark beside a heading or a control: the explanation sits in a tooltip on hover and keyboard focus, and in
 * a popover on a tap where the device cannot hover, so help is there on demand and the page starts with the work.
 * `label` names what it explains for screen readers, which also hear the text itself.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TouchTip
      trigger={<span tabIndex={0} role="note" aria-label={label} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-ring max-sm:size-8" />}
      tip={children}
    >
      <InfoIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{children}</span>
    </TouchTip>
  );
}

/** The list's keyboard keys, on a keyboard mark at the right of the toolbar. Phones have no keys, so it hides there. */
export function KeyboardHint({ noun }: { noun: string }) {
  return (
    <TouchTip
      trigger={<span tabIndex={0} role="note" aria-label="Keyboard keys" className="hidden size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-ring sm:inline-flex" data-testid="keyboard-hint" />}
      tip={
        <>
          <kbd className="font-sans font-semibold">j</kbd> and <kbd className="font-sans font-semibold">k</kbd> move between {noun}, <kbd className="font-sans font-semibold">Enter</kbd> opens the highlighted one.
        </>
      }
    >
      <KeyboardIcon aria-hidden className="size-4" />
      <span className="sr-only">{`j and k move between ${noun}, Enter opens the highlighted one.`}</span>
    </TouchTip>
  );
}
