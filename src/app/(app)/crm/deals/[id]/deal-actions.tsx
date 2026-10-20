"use client";

import { EllipsisIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, formatMinor } from "@/contexts/deals/domain/money";
import { callApi } from "@/lib/api-client";
import { MoveDealStageButton } from "../../_components/move-deal-stage-dialog";
import { NO_OWNER, type DealMemberOption, type DealStageList } from "../../_components/deal-form";

/** The deal as the page read it. `version` goes back as `expectedVersion` on every change. */
export interface DealActionTarget {
  id: string;
  title: string;
  version: number;
  stageId: string;
  stageKind: "open" | "won" | "lost";
  ownerId: string | null;
  ownerIsMember: boolean;
  amountMinor: number | null;
  currency: string | null;
  expectedCloseOn: string | null;
}

const STALE = "Someone changed this deal since you opened it. The page now shows the latest version. Check the fields, then save again.";

/**
 * The deal's actions: Move stage leads, Mark won and Mark lost follow, and the rare ones (Edit, Delete) sit in a More
 * menu, so Delete never stands level with the everyday moves.
 */
export function DealActions({
  deal,
  stages,
  members,
  currentUserId,
  returnPath,
}: {
  deal: DealActionTarget;
  stages: DealStageList;
  members: DealMemberOption[];
  currentUserId: string;
  /** Where a delete lands: the checked `from` of the page, else Pipeline. */
  returnPath: string;
}) {
  const target = { id: deal.id, title: deal.title, version: deal.version, stageId: deal.stageId };
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const onOpenChange = (open: boolean) => !open && setDialog(null);
  return (
    <>
      <MoveDealStageButton deal={target} stages={stages} variant="default" size="default" />
      {deal.stageKind !== "won" && <MoveDealStageButton deal={target} stages={stages} targetKind="won" label="Mark won" size="default" />}
      {deal.stageKind !== "lost" && <MoveDealStageButton deal={target} stages={stages} targetKind="lost" label="Mark lost" size="default" />}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`More actions for ${deal.title}`} />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setDialog("edit")}>
            Edit deal
          </DropdownMenuItem>
          {deal.stageKind === "open" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" onClick={() => setDialog("delete")}>
                Delete deal
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <EditDealDialog deal={deal} members={members} currentUserId={currentUserId} open={dialog === "edit"} onOpenChange={onOpenChange} />
      {deal.stageKind === "open" && <DeleteDealDialog deal={deal} returnPath={returnPath} open={dialog === "delete"} onOpenChange={onOpenChange} />}
    </>
  );
}

interface EditValues {
  title: string;
  owner: string;
  amount: string;
  currency: string;
  expectedCloseOn: string;
}

const valuesOf = (deal: DealActionTarget): EditValues => ({
  title: deal.title,
  owner: deal.ownerId ?? NO_OWNER,
  amount: deal.amountMinor !== null && deal.currency ? formatMinor(deal.amountMinor, deal.currency) : "",
  currency: deal.currency ?? "USD",
  expectedCloseOn: deal.expectedCloseOn ?? "",
});

/** The fields that differ from what the page read, as `PATCH /api/deals/[id]` takes them. */
function changedFields(before: EditValues, after: EditValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (after.title.trim() !== before.title) body.title = after.title.trim();
  if (after.owner !== before.owner) body.ownerId = after.owner === NO_OWNER ? null : after.owner;
  if (after.amount.trim() !== before.amount || (after.amount.trim() !== "" && after.currency !== before.currency)) {
    const amount = after.amount.trim();
    body.amount = amount === "" ? null : amount;
    body.currency = amount === "" ? null : after.currency;
  }
  if (after.expectedCloseOn !== before.expectedCloseOn) body.expectedCloseOn = after.expectedCloseOn || null;
  return body;
}

const CURRENCY_ITEMS = CURRENCIES.map((c) => ({ value: c, label: c }));

function EditDealDialog({
  deal,
  members,
  currentUserId,
  open,
  onOpenChange,
}: {
  deal: DealActionTarget;
  members: DealMemberOption[];
  currentUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState(() => valuesOf(deal));
  const [version, setVersion] = useState(deal.version);
  const [stale, setStale] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Each open starts from the deal as the page read it.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(valuesOf(deal));
      setVersion(deal.version);
      setStale(false);
    }
  }

  const set = <K extends keyof EditValues>(key: K, value: EditValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const ownerItems = [
    ...members.map((m) => ({ value: m.userId, label: m.userId === currentUserId ? `${m.name} (you)` : m.name })),
    ...(deal.ownerId && !deal.ownerIsMember ? [{ value: deal.ownerId, label: "Former member" }] : []),
    { value: NO_OWNER, label: "No owner" },
  ];
  const body = changedFields(valuesOf(deal), values);
  const ready = values.title.trim() !== "" && Object.keys(body).length > 0;

  async function save(): Promise<boolean> {
    const result = await callApi(`/api/deals/${deal.id}`, "PATCH", { expectedVersion: version, ...body });
    if (!result.ok) {
      if (result.details?.code === "stale_version" && typeof result.details.version === "number") {
        setVersion(result.details.version);
        setStale(true);
        router.refresh();
        return false;
      }
      throw new Error(result.error ?? "Could not save the deal. Try again.");
    }
    toast.success("Deal saved.");
    router.refresh();
    return true;
  }

  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Edit ${deal.title}`}
        description="Change the title, owner, amount or expected close date."
        confirmLabel={stale ? "Save again" : "Save"}
        pendingLabel="Saving…"
        confirmDisabled={!ready}
        className="sm:max-w-md"
        onConfirm={save}
      >
        {stale && (
          <p role="status" className="rounded-lg border p-3 text-sm">
            {STALE}
          </p>
        )}
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="edit-deal-title">Title</Label>
            <Input id="edit-deal-title" value={values.title} onChange={(e) => set("title", e.target.value)} maxLength={200} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="edit-deal-owner">Owner</Label>
            <Select items={ownerItems} value={values.owner} onValueChange={(v) => v && set("owner", v)}>
              <SelectTrigger id="edit-deal-owner" className="w-full">
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
          <div className="grid grid-cols-[1fr_6.5rem] gap-3">
            <div className="grid gap-1">
              <Label htmlFor="edit-deal-amount">Amount (optional)</Label>
              <Input id="edit-deal-amount" inputMode="decimal" value={values.amount} onChange={(e) => set("amount", e.target.value)} maxLength={30} placeholder="12000" className="tabular-nums" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="edit-deal-currency">Currency</Label>
              <Select items={CURRENCY_ITEMS} value={values.currency} onValueChange={(v) => v && set("currency", v)}>
                <SelectTrigger id="edit-deal-currency" className="w-full">
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
            <Label htmlFor="edit-deal-close">Expected close (optional)</Label>
            <Input id="edit-deal-close" type="date" value={values.expectedCloseOn} onChange={(e) => set("expectedCloseOn", e.target.value)} className="w-fit" />
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

function DeleteDealDialog({ deal, returnPath, open, onOpenChange }: { deal: DealActionTarget; returnPath: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();

  async function remove() {
    const result = await callApi(`/api/deals/${deal.id}?expectedVersion=${deal.version}`, "DELETE");
    if (!result.ok) {
      if (result.details?.code === "stale_version") {
        router.refresh();
        throw new Error("Someone changed this deal since you opened it. The page now shows the latest version. Check it, then delete it again.");
      }
      throw new Error(result.error ?? "Could not delete the deal. Try again.");
    }
    toast.success(`Deleted ${deal.title}.`);
    // Replace, so Back does not land on a deal that no longer exists.
    router.replace(returnPath);
  }

  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Delete ${deal.title}?`}
        description="The deal leaves the pipeline. The person stays a contact, with their notes, tasks and history."
        confirmLabel="Delete deal"
        cancelLabel="Keep deal"
        pendingLabel="Deleting…"
        destructive
        onConfirm={remove}
      />
    </>
  );
}
