"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/app/_lib/api-client";
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
  /** Preselects this stage, such as the column a deal was dropped on. */
  targetStageId?: string;
  /** Runs with the moved deal (the `GET /api/deals/[id]` shape) after the move. */
  onMoved?: (deal: unknown) => void;
}

const STALE =
  "Someone changed this deal since you opened it. The page now shows the latest version. Check the stage, then move it again.";

/** What a move answered: the moved deal and its new version, a stale version with the server's current one, or an error. */
export type MoveDealResult = { ok: true; deal: unknown; version: number | null } | { ok: false; staleVersion: number } | { ok: false; error: string };

/**
 * Moves a deal to a stage with the version the caller read. The server refuses a stale version, so a change someone
 * made meanwhile stays. The dialog and the board's drag both move through it.
 */
export async function moveDealStage(dealId: string, stageId: string, expectedVersion: number, lostReason: string | null = null): Promise<MoveDealResult> {
  const result = await callApi(`/api/deals/${dealId}/stage`, "POST", { stageId, expectedVersion, lostReason });
  if (result.ok) {
    const version = (result.data as { version?: unknown } | null)?.version;
    return { ok: true, deal: result.data, version: typeof version === "number" ? version : null };
  }
  if (result.code === "stale_version" && typeof result.details?.version === "number") return { ok: false, staleVersion: result.details.version };
  return { ok: false, error: result.error ?? "Could not move the deal. Try again." };
}

/** The sentence a stale move shows on the board, where no dialog is open to hold it. */
export const STALE_MOVE = "Someone changed this deal since the board loaded. The board now shows the latest version; move it again.";

/**
 * Move stage, Mark won and Mark lost. A Lost stage asks for its reason. The move sends the version
 * the caller read; a 409 `stale_version` keeps the dialog open with the message, takes the server's version and lets the
 * person move again.
 */
export function MoveDealStageDialog({ open, onOpenChange, deal, stages: givenStages, targetKind, targetStageId, onMoved }: MoveDealStageDialogProps) {
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
  const chosenValue = target ?? (targetStageId && choices.some((c) => c.value === targetStageId) ? targetStageId : targetKind ? (choices.find((c) => c.kind === targetKind)?.value ?? null) : null);
  const chosen = choices.find((c) => c.value === chosenValue);
  const ready = chosen !== undefined && (chosen.kind !== "lost" || lostReason.trim() !== "");
  const title = targetKind === "won" ? `Mark ${deal.title} won` : targetKind === "lost" ? `Mark ${deal.title} lost` : `Move ${deal.title}`;

  async function move(): Promise<boolean> {
    if (!chosen) return false;
    const result = await moveDealStage(deal.id, chosen.value, version, chosen.kind === "lost" ? lostReason.trim() : null);
    if (!result.ok) {
      if ("staleVersion" in result) {
        setVersion(result.staleVersion);
        setStale(true);
        router.refresh();
        return false;
      }
      throw new Error(result.error);
    }
    toast.success(`Moved ${deal.title} to ${chosen.label}.`);
    onMoved?.(result.deal);
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
      pendingLabel="Moving…"
      confirmDisabled={!ready}
      onConfirm={move}
    >
      {stale && (
        <p role="status" className="text-sm">
          {STALE}
        </p>
      )}
      {stagesError && (
        <p role="alert" className="text-sm text-destructive">
          {stagesError}
        </p>
      )}
      <Field>
        <FieldLabel htmlFor={`move-deal-${deal.id}`}>New stage</FieldLabel>
        <Select items={choices} value={chosenValue} onValueChange={(v) => v && setTarget(v)} disabled={choices.length === 0}>
          <SelectTrigger id={`move-deal-${deal.id}`} className="w-full">
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
      </Field>
      {chosen?.kind === "lost" && (
        <Field>
          <FieldLabel htmlFor={`move-deal-reason-${deal.id}`}>Lost reason</FieldLabel>
          <Input id={`move-deal-reason-${deal.id}`} value={lostReason} onChange={(e) => setLostReason(e.target.value)} maxLength={500} placeholder="Went with a competitor" />
        </Field>
      )}
    </ConfirmDialog>
  );
}

/** A Move stage button with its dialog. */
export function MoveDealStageButton({
  label = "Move stage",
  variant = "outline",
  size = "sm",
  disabled = false,
  touch = false,
  className,
  ...props
}: Omit<MoveDealStageDialogProps, "open" | "onOpenChange"> & {
  label?: string;
  variant?: "default" | "outline";
  size?: "default" | "sm" | "xs";
  /** Off while another move of this deal is on its way. */
  disabled?: boolean;
  /** 44px on a phone, where the button sits on a card a person taps. */
  touch?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} touch={touch} className={className} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </Button>
      <MoveDealStageDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
