"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/lib/api-client";
import { useDealStages } from "./deal-fields";
import { stageChoices, type DealStageList, type DealStageOption } from "./deal-form";

/** The deal as the caller read it. `version` is the optimistic lock the move sends as `expectedVersion`. */
export interface MoveDealTarget {
  id: string;
  title: string;
  version: number;
  stageId: string;
}

export interface MoveDealStageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal: MoveDealTarget;
  /** The pipeline's stages. Left out, the dialog loads them when it first opens. */
  stages?: DealStageList;
  /** Mark won and Mark lost: preselects the first stage of that kind and names the action in the title. */
  targetKind?: Exclude<DealStageOption["kind"], "open">;
  /** Runs with the moved deal (the `GET /api/deals/[id]` shape) after the move. */
  onMoved?: (deal: unknown) => void;
}

const STALE =
  "Someone changed this deal since you opened it. The page now shows the latest version. Check the stage, then move it again.";

/**
 * Move stage, Mark won and Mark lost. A Lost stage asks for its reason. The move sends the version
 * the caller read; a 409 `stale_version` keeps the dialog open with the message, takes the server's version and lets the
 * person move again.
 */
export function MoveDealStageDialog({ open, onOpenChange, deal, stages: givenStages, targetKind, onMoved }: MoveDealStageDialogProps) {
  const router = useRouter();
  const { stages, error: stagesError } = useDealStages(open, givenStages);
  const [target, setTarget] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [version, setVersion] = useState(deal.version);
  const [stale, setStale] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTarget(null);
      setLostReason("");
      setVersion(deal.version);
      setStale(false);
    }
  }

  const choices = stageChoices(stages).filter((c) => c.value !== deal.stageId);
  const chosenValue = target ?? (targetKind ? (choices.find((c) => c.kind === targetKind)?.value ?? null) : null);
  const chosen = choices.find((c) => c.value === chosenValue);
  const ready = chosen !== undefined && (chosen.kind !== "lost" || lostReason.trim() !== "");
  const title = targetKind === "won" ? `Mark ${deal.title} won` : targetKind === "lost" ? `Mark ${deal.title} lost` : `Move ${deal.title}`;

  async function move(): Promise<boolean> {
    if (!chosen) return false;
    const result = await callApi(`/api/deals/${deal.id}/stage`, "POST", {
      stageId: chosen.value,
      expectedVersion: version,
      lostReason: chosen.kind === "lost" ? lostReason.trim() : null,
    });
    if (!result.ok) {
      if (result.details?.code === "stale_version" && typeof result.details.version === "number") {
        setVersion(result.details.version);
        setStale(true);
        router.refresh();
        return false;
      }
      throw new Error(result.error ?? "Could not move the deal. Try again.");
    }
    toast.success(`Moved ${deal.title} to ${chosen.label}.`);
    onMoved?.(result.data);
    router.refresh();
    return true;
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={chosen?.kind === "lost" ? "A lost deal keeps its reason, so the team can see why later." : "Pick the stage the deal is in now."}
      confirmLabel={stale ? "Move again" : targetKind === "won" ? "Mark won" : targetKind === "lost" ? "Mark lost" : "Move"}
      pendingLabel="Moving..."
      confirmDisabled={!ready}
      onConfirm={move}
    >
      {stale && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {STALE}
        </p>
      )}
      {stagesError && (
        <p role="alert" className="text-sm text-destructive">
          {stagesError}
        </p>
      )}
      <div className="grid gap-1">
        <Label htmlFor={`move-deal-${deal.id}`}>New stage</Label>
        <Select items={choices} value={chosenValue} onValueChange={(v) => v && setTarget(v)} disabled={choices.length === 0}>
          <SelectTrigger id={`move-deal-${deal.id}`} className="w-full">
            <SelectValue placeholder={stages ? "Choose a stage" : "Loading stages..."} />
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
      {chosen?.kind === "lost" && (
        <div className="grid gap-1">
          <Label htmlFor={`move-deal-reason-${deal.id}`}>Lost reason</Label>
          <Input id={`move-deal-reason-${deal.id}`} value={lostReason} onChange={(e) => setLostReason(e.target.value)} maxLength={500} placeholder="Went with a competitor" />
        </div>
      )}
    </ConfirmDialog>
  );
}

/** A Move stage button with its dialog. */
export function MoveDealStageButton({
  label = "Move stage",
  variant = "outline",
  size = "sm",
  ...props
}: Omit<MoveDealStageDialogProps, "open" | "onOpenChange"> & { label?: string; variant?: "default" | "outline"; size?: "default" | "sm" | "xs" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <MoveDealStageDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
