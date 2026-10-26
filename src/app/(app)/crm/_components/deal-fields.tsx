"use client";

import { useEffect, useState } from "react";
import { DatePicker } from "@/components/shell/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES } from "@/contexts/deals/domain/money";
import { callApi } from "@/app/_lib/api-client";
import { memberItems } from "@/app/(app)/_components/member-select";
import { NO_OWNER, stageChoices, type DealFieldValues, type DealMemberOption, type DealStageList } from "./deal-form";

/** The stages for a dialog: the `given` list, or one fetch the first time the dialog opens. */
export function useDealStages(open: boolean, given?: DealStageList): { stages: DealStageList | null; error: string | null } {
  const [fetched, setFetched] = useState<DealStageList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const need = open && !given && !fetched;
  useEffect(() => {
    if (!need) return;
    let live = true;
    void callApi<DealStageList>("/api/deal-stages", "GET").then((result) => {
      if (!live) return;
      if (result.ok && result.data) setFetched(result.data);
      else setError(result.error ?? "Could not load the stages. Close the dialog and try again.");
    });
    return () => {
      live = false;
    };
  }, [need]);
  return { stages: given ?? fetched, error: given || fetched ? null : error };
}

const CURRENCY_ITEMS = CURRENCIES.map((c) => ({ value: c, label: c }));

/**
 * The deal form of the Create deal dialogs. `full` adds title, amount with currency and expected close to stage and
 * owner. A Lost stage asks for its reason.
 */
export function DealFields({
  idPrefix,
  values,
  onChange,
  stages,
  members,
  currentUserId,
  full,
  disabled = false,
}: {
  idPrefix: string;
  values: DealFieldValues;
  onChange: (next: DealFieldValues) => void;
  stages: DealStageList | null;
  members: DealMemberOption[];
  currentUserId: string;
  full: boolean;
  disabled?: boolean;
}) {
  const set = <K extends keyof DealFieldValues>(key: K, value: DealFieldValues[K]) => onChange({ ...values, [key]: value });
  const choices = stageChoices(stages);
  const chosen = choices.find((c) => c.value === values.stage);
  const ownerItems = memberItems(members, currentUserId, values.owner, { value: NO_OWNER, label: "No owner", at: "end" });
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="grid gap-3">
      {full && (
        <div className="grid gap-1">
          <Label htmlFor={id("title")}>Title</Label>
          <Input id={id("title")} value={values.title} onChange={(e) => set("title", e.target.value)} maxLength={200} disabled={disabled} />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={id("stage")}>Stage</Label>
          <Select items={choices} value={values.stage} onValueChange={(v) => v && set("stage", v)} disabled={disabled || choices.length === 0}>
            <SelectTrigger id={id("stage")} className="w-full">
              <SelectValue placeholder={stages ? "Choose a stage" : "Loading stages…"} />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={id("owner")}>Owner</Label>
          <Select items={ownerItems} value={values.owner} onValueChange={(v) => v && set("owner", v)} disabled={disabled}>
            <SelectTrigger id={id("owner")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ownerItems.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {chosen?.kind === "lost" && (
        <div className="grid gap-1">
          <Label htmlFor={id("lost-reason")}>Lost reason</Label>
          <Input id={id("lost-reason")} value={values.lostReason} onChange={(e) => set("lostReason", e.target.value)} maxLength={500} placeholder="Went with a competitor" disabled={disabled} />
        </div>
      )}
      {full && (
        <>
          <div className="grid grid-cols-[1fr_6.5rem] gap-3">
            <div className="grid gap-1">
              <Label htmlFor={id("amount")}>Amount (optional)</Label>
              <Input id={id("amount")} inputMode="decimal" value={values.amount} onChange={(e) => set("amount", e.target.value)} maxLength={30} placeholder="12000" className="tabular-nums" disabled={disabled} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={id("currency")}>Currency</Label>
              <Select items={CURRENCY_ITEMS} value={values.currency} onValueChange={(v) => v && set("currency", v)} disabled={disabled}>
                <SelectTrigger id={id("currency")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_ITEMS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={id("close")}>Expected close (optional)</Label>
            <DatePicker id={id("close")} value={values.expectedCloseOn} onChange={(day) => set("expectedCloseOn", day)} clearable className="w-40" disabled={disabled} />
          </div>
        </>
      )}
    </div>
  );
}
