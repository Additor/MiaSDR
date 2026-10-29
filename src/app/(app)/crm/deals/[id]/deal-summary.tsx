"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, formatMinor } from "@/contexts/deals/domain/money";
import { cn } from "@/components/ui/utils";
import { callApi } from "@/app/_lib/api-client";
import { NO_OWNER, type DealMemberOption } from "../../_components/deal-form";
import { EditableFact, InlineForm, NotSet, type EditorProps, type SaveResult } from "@/app/(app)/_components/record/inline-field";

const STALE = "Someone changed this deal since you opened it. The page now shows the latest version. Check the value, then save again.";
const CURRENCY_ITEMS = CURRENCIES.map((c) => ({ value: c, label: c }));

export interface SummaryDeal {
  id: string;
  version: number;
  amountMinor: number | null;
  currency: string | null;
  /** The amount as the page prints it, such as "$12,000.00". */
  amountText: string | null;
  ownerId: string | null;
  ownerIsMember: boolean;
  ownerText: string;
  expectedCloseOn: string | null;
  overdue: boolean;
}

/**
 * The deal facts you edit on their own row: amount, deal owner and expected close. Each save sends that field with the
 * version the page read, so a change someone made in between is never overwritten.
 */
export function DealSummaryFields({ deal, members, currentUserId }: { deal: SummaryDeal; members: DealMemberOption[]; currentUserId: string }) {
  const router = useRouter();

  async function save(body: Record<string, unknown>): Promise<SaveResult> {
    const result = await callApi(`/api/deals/${deal.id}`, "PATCH", { expectedVersion: deal.version, ...body });
    if (result.ok) return null;
    if (result.code === "stale_version") {
      router.refresh();
      return STALE;
    }
    return result.issues[0]?.message ?? result.error ?? "Could not save the deal. Try again.";
  }

  const ownerItems = [
    ...members.map((m) => ({ value: m.userId, label: m.userId === currentUserId ? `${m.name} (you)` : m.name })),
    ...(deal.ownerId && !deal.ownerIsMember ? [{ value: deal.ownerId, label: "Former member" }] : []),
    { value: NO_OWNER, label: "No owner" },
  ];

  return (
    <>
      <EditableFact label="Amount" saved="Amount saved." editor={(props) => <AmountEditor {...props} deal={deal} save={save} />}>
        {deal.amountText ? <span className="tabular-nums">{deal.amountText}</span> : <NotSet />}
      </EditableFact>
      <EditableFact
        label="Deal owner"
        saved="Deal owner saved."
        editor={(props) => <OwnerEditor {...props} value={deal.ownerId ?? NO_OWNER} items={ownerItems} save={(owner) => save({ ownerId: owner === NO_OWNER ? null : owner })} />}
      >
        {deal.ownerText}
      </EditableFact>
      <EditableFact
        label="Expected close"
        saved="Expected close saved."
        inputs={[{ key: "expectedCloseOn", value: deal.expectedCloseOn ?? "", type: "date", help: "Clear in the calendar removes the date." }]}
        onSave={(v) => save({ expectedCloseOn: v.expectedCloseOn || null })}
      >
        {deal.expectedCloseOn ? (
          <span className={cn("tabular-nums", deal.overdue && "font-medium")}>
            {deal.expectedCloseOn}
            {deal.overdue && <span className="font-normal text-muted-foreground">, overdue</span>}
          </span>
        ) : (
          <NotSet />
        )}
      </EditableFact>
    </>
  );
}

function AmountEditor({ deal, save, close }: EditorProps & { deal: SummaryDeal; save: (body: Record<string, unknown>) => Promise<SaveResult> }) {
  const base = useId();
  const initial = deal.amountMinor !== null && deal.currency ? formatMinor(deal.amountMinor, deal.currency) : "";
  const [amount, setAmount] = useState(initial);
  const [currency, setCurrency] = useState(deal.currency ?? "USD");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const typed = amount.trim();
    if (typed === initial && (typed === "" || currency === deal.currency)) return close(false);
    setPending(true);
    setError(null);
    const problem = await save(typed === "" ? { amount: null, currency: null } : { amount: typed, currency });
    setPending(false);
    if (problem) return setError(problem);
    close(true);
  }

  return (
    <InlineForm label={null} onSubmit={onSubmit} onCancel={() => close(false)} busy={pending} error={error} errorId={`${base}-error`}>
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-group">
        <Field>
          <FieldLabel htmlFor={`${base}-amount`}>Amount</FieldLabel>
          <Input id={`${base}-amount`} autoFocus inputMode="decimal" value={amount} maxLength={30} placeholder="12000" touch className="tabular-nums" onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${base}-currency`}>Currency</FieldLabel>
          <Select items={CURRENCY_ITEMS} value={currency} onValueChange={(v) => v && setCurrency(v)}>
            <SelectTrigger id={`${base}-currency`} className="w-full max-sm:data-[size=default]:h-11">
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
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">Empty clears the amount.</p>
    </InlineForm>
  );
}

function OwnerEditor({ value, items, save, close }: EditorProps & { value: string; items: Array<{ value: string; label: string }>; save: (owner: string) => Promise<SaveResult> }) {
  const base = useId();
  const [owner, setOwner] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (owner === value) return close(false);
    setPending(true);
    setError(null);
    const problem = await save(owner);
    setPending(false);
    if (problem) return setError(problem);
    close(true);
  }

  return (
    <InlineForm label={null} onSubmit={onSubmit} onCancel={() => close(false)} busy={pending} error={error} errorId={`${base}-error`}>
      <Field>
        <FieldLabel htmlFor={`${base}-owner`}>Deal owner</FieldLabel>
        <Select items={items} value={owner} onValueChange={(v) => v && setOwner(v)}>
          <SelectTrigger id={`${base}-owner`} autoFocus className="w-full max-sm:data-[size=default]:h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </InlineForm>
  );
}
