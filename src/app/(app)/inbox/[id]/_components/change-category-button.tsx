"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/api-client";
import { categoryLabel } from "@/app/(app)/crm/_components/labels";

export interface StageOption {
  id: string;
  /** The taxonomy key, which a correction of the reply's reading names. */
  key: string;
  categoryKey: string;
  name: string;
  stageRank: number | null;
}

/**
 * The one place to change the reply category. The person says why: the AI read the last reply wrong (a correction of that
 * reading, recorded as a human classification of this conversation), or something happened off the thread (the record
 * moves; the reading stays and open drafts retire).
 */
export function ChangeCategoryButton({
  recordId,
  conversationId,
  personName,
  contextVersion,
  currentSubcategoryId,
  categoryLocked,
  stages,
  size = "sm",
}: {
  recordId: string;
  /** The conversation on screen. Without it only an off-thread change is offered. */
  conversationId?: string;
  personName: string;
  contextVersion: number;
  currentSubcategoryId: string | null;
  categoryLocked: boolean;
  stages: StageOption[];
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [unlock, setUnlock] = useState(false);
  const [why, setWhy] = useState<"reply" | "offThread">(conversationId ? "reply" : "offThread");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const correcting = why === "reply" && conversationId !== undefined;
  // A correction may name the category the record already has, to confirm the reading; a move goes somewhere else.
  const options = stages.filter((s) => correcting || s.id !== currentSubcategoryId).map((s) => ({ value: s.id, label: `${categoryLabel(s.categoryKey)}: ${s.name}` }));
  const chosen = stages.find((s) => s.id === target);
  const leavesCustomer = !correcting && categoryLocked && chosen !== undefined && chosen.categoryKey !== "customer";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    setPending(true);
    setError(null);
    const result = correcting
      ? await callApi(`/api/inbox/${conversationId}/classification`, "POST", { subcategoryKey: chosen.key, expectedContextVersion: contextVersion })
      : await callApi(`/api/records/${recordId}/stage`, "POST", {
          categoryKey: chosen.categoryKey,
          subcategoryId: chosen.id,
          expectedContextVersion: contextVersion,
          confirmUnlock: unlock,
          note: note.trim() || null,
        });
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success(`Changed the category of ${personName} to ${chosen.name}.`);
    setOpen(false);
    setTarget(null);
    setNote("");
    setUnlock(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size={size} className="max-sm:h-11" />}>Change category</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Change the category of {personName}</DialogTitle>
            <DialogDescription>
              {correcting ? "The last reply moves to the category you choose, as your reading of it." : "The AI's reading of the last reply stays as it was. Open drafts are retired because they no longer fit."}
            </DialogDescription>
          </DialogHeader>
          {conversationId && (
            <fieldset className="grid gap-2 text-sm">
              <legend className="mb-1 text-sm font-medium">What changed?</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name={`why-${recordId}`} checked={why === "reply"} onChange={() => setWhy("reply")} />
                The AI read the last reply wrong
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={`why-${recordId}`} checked={why === "offThread"} onChange={() => setWhy("offThread")} />
                Something happened off the thread, like a meeting
              </label>
            </fieldset>
          )}
          <div className="grid gap-1">
            <Label htmlFor={`category-${recordId}`}>New category</Label>
            <Select items={options} value={target} onValueChange={(v) => setTarget(v)}>
              <SelectTrigger id={`category-${recordId}`} className="w-full">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!correcting && (
            <div className="grid gap-1">
              <Label htmlFor={`note-${recordId}`}>Note (optional)</Label>
              <Textarea id={`note-${recordId}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} placeholder="Met on Tuesday, wants a trial" />
            </div>
          )}
          {leavesCustomer && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <Checkbox id={`unlock-${recordId}`} checked={unlock} onCheckedChange={(c) => setUnlock(c === true)} />
              <div className="grid gap-0.5">
                <Label htmlFor={`unlock-${recordId}`} className="font-normal">
                  This person is locked as Existing customer. Take them out of it.
                </Label>
                <p className="text-xs text-muted-foreground">Existing customers stay locked so the AI cannot reclassify them. You can still change the category.</p>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending || !chosen || (leavesCustomer && !unlock)}>
              {pending ? "Changing…" : "Change category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
