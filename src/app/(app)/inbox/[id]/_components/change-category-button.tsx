"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList } from "@/components/ui/combobox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { PROTECTED_SUBCATEGORY_KEY, REPLY_TYPE_GROUPS } from "@/contexts/conversations/domain/reply-handling";
import { needsReply } from "@/contexts/conversations/domain/reply-policy";
import { callApi } from "@/app/_lib/api-client";
import { groupLabel } from "@/contexts/conversations/domain/reply-handling";
import { saveDraftEdits } from "../_lib/draft-edits";

export interface StageOption {
  id: string;
  /** The taxonomy key, which a correction of the reply's reading names. */
  key: string;
  groupKey: string;
  name: string;
}

/** The AI's reading of the last reply, shown above the picker so you correct it with it in view. */
export interface AiReading {
  name: string;
  confidence: number | null;
  reasoning: string | null;
}

interface Option {
  value: string;
  label: string;
  stage: StageOption;
}

/**
 * Changes the reply category, from the thread's Next step. The person says why: the AI read the last reply wrong (a correction
 * of that reading, recorded as a human classification of this conversation), or something happened off the thread (the record
 * moves; the reading stays and open drafts retire). The picker groups the subcategories under their category and filters as you
 * type, and the line under it says what the change does before you confirm. Unsaved edits in the reply editor are saved first,
 * so the out-of-date draft keeps them.
 */
export function ChangeCategoryButton({
  recordId,
  conversationId,
  personName,
  contextVersion,
  currentReplyTypeId,
  replyTypeLocked,
  stages,
  aiReading = null,
}: {
  recordId: string;
  /** The conversation on screen. Without it only an off-thread change is offered. */
  conversationId?: string;
  personName: string;
  contextVersion: number;
  currentReplyTypeId: string | null;
  replyTypeLocked: boolean;
  stages: StageOption[];
  aiReading?: AiReading | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Option | null>(null);
  const [note, setNote] = useState("");
  const [unlock, setUnlock] = useState(false);
  const [why, setWhy] = useState<"reply" | "offThread">(conversationId ? "reply" : "offThread");

  const correcting = why === "reply" && conversationId !== undefined;
  // A correction may name the category the record already has, to confirm the reading; a move goes somewhere else.
  const groups = useMemo(
    () =>
      REPLY_TYPE_GROUPS.map((c) => ({
        value: c.label,
        items: stages.filter((s) => s.groupKey === c.key && (correcting || s.id !== currentReplyTypeId)).map((s) => ({ value: s.id, label: s.name, stage: s })),
      })).filter((g) => g.items.length > 0),
    [stages, correcting, currentReplyTypeId],
  );
  const chosen = target && groups.some((g) => g.items.some((o) => o.value === target.value)) ? target.stage : undefined;
  const leavesCustomer = !correcting && replyTypeLocked && chosen !== undefined && chosen.groupKey !== "customer";

  function reset(next: boolean) {
    setOpen(next);
    if (next) return;
    setTarget(null);
    setNote("");
    setUnlock(false);
    setWhy(conversationId ? "reply" : "offThread");
  }

  async function submit() {
    if (!chosen) return false;
    const unsaved = await saveDraftEdits();
    if (unsaved) throw new Error(`Your draft edits were not saved, so nothing changed. ${unsaved}`);
    const result = correcting
      ? await callApi(`/api/inbox/${conversationId}/reply-type`, "POST", { replyTypeKey: chosen.key, expectedContextVersion: contextVersion })
      : await callApi(`/api/records/${recordId}/reply-type`, "POST", {
          groupKey: chosen.groupKey,
          replyTypeId: chosen.id,
          expectedContextVersion: contextVersion,
          confirmUnlock: unlock,
          note: note.trim() || null,
        });
    if (!result.ok) throw new Error(result.error ?? "The category did not change. Try again.");
    toast.success(`Changed the category of ${personName} to ${groupLabel(chosen.groupKey)}: ${chosen.name}.`);
    reset(false);
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => setOpen(true)}>
        Change category
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={reset}
        title={`Change the category of ${personName}`}
        description={correcting ? "Your reading of the last reply replaces the AI's." : "The AI's reading of the last reply stays. The category moves because of something that happened elsewhere."}
        confirmLabel="Change category"
        pendingLabel="Changing…"
        confirmDisabled={!chosen || (leavesCustomer && !unlock)}
        className="sm:max-w-md"
        onConfirm={submit}
      >
        <FieldGroup>
          {correcting && aiReading && (
            <p className="text-sm text-muted-foreground" data-testid="ai-reading">
              The AI read it as <span className="text-foreground">{aiReading.name}</span>
              {aiReading.confidence != null && ` (${Math.round(aiReading.confidence * 100)}% confident)`}
              {aiReading.reasoning ? `: ${aiReading.reasoning}` : "."}
            </p>
          )}
          {conversationId && (
            <FieldSet>
              <FieldLegend variant="label">What changed?</FieldLegend>
              <RadioGroup value={why} onValueChange={(v) => setWhy(v as "reply" | "offThread")}>
                <Field orientation="horizontal">
                  <RadioGroupItem value="reply" id={`why-reply-${recordId}`} />
                  <FieldLabel htmlFor={`why-reply-${recordId}`} className="font-normal">
                    The AI read the last reply wrong
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="offThread" id={`why-off-${recordId}`} />
                  <FieldLabel htmlFor={`why-off-${recordId}`} className="font-normal">
                    Something happened off the thread, like a meeting
                  </FieldLabel>
                </Field>
              </RadioGroup>
            </FieldSet>
          )}
          <Field>
            <FieldLabel htmlFor={`category-${recordId}`}>New category</FieldLabel>
            <Combobox items={groups} value={target} onValueChange={(next) => setTarget((next as Option | null) ?? null)} itemToStringLabel={(o: Option) => `${groupLabel(o.stage.groupKey)}: ${o.label}`} autoHighlight>
              <ComboboxInput id={`category-${recordId}`} placeholder="Search categories" className="w-full" />
              <ComboboxContent>
                <ComboboxEmpty>No category matches.</ComboboxEmpty>
                <ComboboxList>
                  {(group: (typeof groups)[number]) => (
                    <ComboboxGroup key={group.value} items={group.items}>
                      <ComboboxLabel>{group.value}</ComboboxLabel>
                      <ComboboxCollection>
                        {(option: Option) => (
                          <ComboboxItem key={option.value} value={option}>
                            {option.label}
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            {chosen && (
              <FieldDescription className="text-foreground" data-testid="category-consequence">
                {consequence(chosen, correcting, personName)}
              </FieldDescription>
            )}
          </Field>
          {!correcting && (
            <Field>
              <FieldLabel htmlFor={`note-${recordId}`}>Note (optional)</FieldLabel>
              <Textarea id={`note-${recordId}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} placeholder="Met on Tuesday, wants a trial" />
            </Field>
          )}
          {leavesCustomer && (
            <Field orientation="horizontal">
              <Checkbox id={`unlock-${recordId}`} checked={unlock} onCheckedChange={(c) => setUnlock(c === true)} />
              <FieldContent>
                <FieldLabel htmlFor={`unlock-${recordId}`} className="font-normal">
                  This person is locked as Existing customer. Take them out of it.
                </FieldLabel>
                <FieldDescription>Existing customers stay locked so the AI cannot reclassify them. You can still change the category.</FieldDescription>
              </FieldContent>
            </Field>
          )}
        </FieldGroup>
      </ConfirmDialog>
    </>
  );
}

/** What the change does to drafts, follow-ups and contact, in one or two sentences. */
function consequence(stage: StageOption, correcting: boolean, personName: string): string {
  const stop = stage.key === PROTECTED_SUBCATEGORY_KEY ? ` It also marks ${personName} do not contact on every channel.` : "";
  if (!correcting) return `Retires open drafts and restarts follow-ups for this category. No new draft is written.${stop}`;
  if (needsReply(stage.groupKey, stage.key)) return `Retires the open draft, writes a new one for this category and starts its follow-ups.${stop}`;
  return `Retires the open draft. This category needs no reply, so none is written.${stop}`;
}
