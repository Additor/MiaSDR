"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList } from "@/components/ui/combobox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { CUSTOMER_GROUP, REPLY_TYPE_GROUPS, groupLabel } from "@/contexts/conversations/domain/reply-handling";
import type { SystemRole, TypeChangeOutcome } from "@/contexts/conversations/domain/reply-type";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { submitSteps } from "../_lib/change-type";
import { saveDraftEdits, unsavedEditsError } from "../_lib/draft-edits";
import { confidenceText } from "../_lib/type-line";
import { useStopScope, type StopTarget } from "./stop-contacting";

export interface TypeOption {
  id: string;
  /** The type's key, which a person's pick for the latest reply names. */
  key: string;
  groupKey: string;
  name: string;
  systemRole: SystemRole | null;
}

/** The AI's pick for the last reply, shown above the picker so you correct it with it in view. */
export interface AiReading {
  name: string;
  confidence: number | null;
  reasoning: string | null;
}

interface Option {
  value: string;
  label: string;
  type: TypeOption;
}

type Path = "correct" | "off_thread";
/** The outcome lines of one path, or why they did not load. */
type Outcomes = { path: Path; lines: ReadonlyMap<string, TypeChangeOutcome>; error: null } | { path: Path; lines: null; error: string };

/**
 * Changes the reply type, from the thread's type line. The person says why, and that picks the path:
 *
 * - The AI read the last reply wrong: a person's pick for the latest reply (`POST /api/inbox/[id]/reply-type` with the type's
 *   key). The new type's rules apply as for any pick, so a type set to write a draft gets one.
 * - Something happened off the thread: the record's type moves (`POST /api/records/[id]/reply-type`), the AI's pick stays, and
 *   no draft is written.
 *
 * The three outcome lines come from `GET /api/records/[id]/reply-type/outcomes`, for the path of the chosen answer. Choosing the stop request type asks how far
 * the stop reaches inside this dialog: Stop contacting changes the type and stops contact, Only change the type does not
 * stop anything. Unsaved edits in the reply editor are saved first, so the out-of-date draft keeps them.
 */
export function ChangeTypeButton({
  recordId,
  conversationId,
  personName,
  contextVersion,
  currentReplyTypeId,
  replyTypeLocked,
  types,
  aiReading = null,
  stop,
  variant = "link",
}: {
  recordId: string;
  /** The conversation on screen. Without it only an off-thread change is offered. */
  conversationId?: string;
  personName: string;
  contextVersion: number;
  currentReplyTypeId: string | null;
  replyTypeLocked: boolean;
  types: TypeOption[];
  aiReading?: AiReading | null;
  /** What Stop contacting needs, and whether the person is already marked. */
  stop: StopTarget & { doNotContact: boolean };
  /** A link at the end of the type line, an outline button beside Accept or Looks right, or the lead button when the AI's pick names an archived type. */
  variant?: "link" | "outline" | "default";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Option | null>(null);
  const [note, setNote] = useState("");
  const [unlock, setUnlock] = useState(false);
  const [why, setWhy] = useState<"reply" | "offThread">(conversationId ? "reply" : "offThread");
  const [outcomes, setOutcomes] = useState<Outcomes | null>(null);
  // The type this dialog already changed to. A retry after a failed stop only stops.
  const changedTo = useRef<string | null>(null);
  const stopScope = useStopScope(stop);

  const correcting = why === "reply" && conversationId !== undefined;
  const groups = useMemo(
    () =>
      REPLY_TYPE_GROUPS.map((g) => ({
        value: g.label,
        items: types.filter((t) => t.groupKey === g.key && t.id !== currentReplyTypeId).map((t) => ({ value: t.id, label: t.name, type: t })),
      })).filter((g) => g.items.length > 0),
    [types, currentReplyTypeId],
  );
  const chosen = target?.type;
  const leavesCustomer = replyTypeLocked && chosen !== undefined && chosen.groupKey !== CUSTOMER_GROUP;
  const asksStop = chosen?.systemRole === "stop_request" && !stop.doNotContact;
  const path: Path = correcting ? "correct" : "off_thread";
  // Lines loaded for the other path wait for this path's own.
  const loaded = outcomes?.path === path ? outcomes : null;
  const outcome = chosen ? loaded?.lines?.get(chosen.id) : undefined;
  const outcomeError = loaded?.error ?? null;

  // The outcome lines depend on the record as it is now and on the path, so they load when the dialog opens and again
  // when the answer to What changed? moves the change to the other path.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void callApi<{ outcomes: Array<{ replyTypeId: string; outcome: TypeChangeOutcome }> }>(`/api/records/${recordId}/reply-type/outcomes?path=${path}`, "GET", undefined, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok && result.data) setOutcomes({ path, lines: new Map(result.data.outcomes.map((o) => [o.replyTypeId, o.outcome])), error: null });
      else setOutcomes({ path, lines: null, error: result.error ?? "What the change does did not load." });
    });
    return () => controller.abort();
  }, [open, recordId, contextVersion, path]);

  function change(next: boolean) {
    setOpen(next);
    if (next) return;
    // The page catches up once the dialog closes. A refresh while it stays open can take away the decision block that
    // holds this button, and the dialog with the failure it shows.
    if (changedTo.current) router.refresh();
    setTarget(null);
    setNote("");
    setUnlock(false);
    setWhy(conversationId ? "reply" : "offThread");
    setOutcomes(null);
    changedTo.current = null;
    stopScope.reset();
  }

  async function changeType(type: TypeOption) {
    // Closing the dialog refreshes the page once the type changed, so this call reloads nothing itself.
    const body = { groupKey: type.groupKey, replyTypeId: type.id, expectedContextVersion: contextVersion, confirmUnlock: unlock, note: note.trim() || null };
    orThrow(
      await runApiAction(
        correcting ? callApi(`/api/inbox/${conversationId}/reply-type`, "POST", { replyTypeKey: type.key, expectedContextVersion: contextVersion }) : callApi(`/api/records/${recordId}/reply-type`, "POST", body),
      ),
    );
  }

  /**
   * Runs inside `ConfirmDialog`, which guards against a second press, shows the pending label and the thrown message, and
   * closes when this resolves. A stop scope that is not filled in yet resolves `false`, so the dialog stays open. Closing
   * refreshes the page once the type changed (`change`), so a stop that fails after the change keeps its message here.
   */
  async function submit(mode: "change" | "stop"): Promise<boolean | void> {
    if (!chosen) return false;
    if (mode === "stop" && !stopScope.ready()) return false;
    const steps = submitSteps(changedTo.current, chosen.id, mode);
    if (steps.change) {
      const unsaved = await saveDraftEdits();
      if (unsaved) throw new Error(unsavedEditsError(unsaved));
      await changeType(chosen);
      changedTo.current = chosen.id;
    }
    const changedText = `Changed the reply type of ${personName} to ${chosen.name}.`;
    if (steps.stop) {
      const stopped = await stopScope.stop().catch((e: unknown) => {
        throw new Error(`The reply type changed, but contact did not stop. ${e instanceof Error ? e.message : ""} Use Stop contacting under Next step.`.trim());
      });
      toast.success(`${changedText} ${stopped}`);
    } else {
      toast.success(changedText);
    }
  }

  const ready = chosen !== undefined && !(leavesCustomer && !unlock);

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        touch={variant !== "link"}
        className={variant === "link" ? "h-auto px-0 text-foreground underline decoration-muted-foreground/50 hover:decoration-foreground max-sm:min-h-11" : undefined}
        onClick={() => setOpen(true)}
      >
        Change type
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={change}
        className="sm:max-w-md"
        title={`Change the reply type of ${personName}`}
        description={correcting ? "Your pick for the last reply replaces the AI's." : "The AI's pick for the last reply stays. The type changes because of something that happened elsewhere."}
        confirmLabel={asksStop ? "Stop contacting" : "Change type"}
        pendingLabel={asksStop ? "Stopping…" : "Changing…"}
        destructive={asksStop}
        confirmDisabled={!ready}
        secondary={asksStop ? { label: "Only change the type", pendingLabel: "Changing…", disabled: !ready, onConfirm: () => submit("change") } : undefined}
        onConfirm={() => submit(asksStop ? "stop" : "change")}
      >
            <FieldGroup>
              {correcting && aiReading && (
                <p className="text-sm text-muted-foreground" data-testid="ai-reading">
                  The AI picked <span className="text-foreground">{aiReading.name}</span>
                  {aiReading.confidence != null && `, ${confidenceText(aiReading.confidence)}`}
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
                <FieldLabel htmlFor={`type-${recordId}`}>New type</FieldLabel>
                <Combobox items={groups} value={target} onValueChange={(next) => setTarget((next as Option | null) ?? null)} itemToStringLabel={(o: Option) => `${o.label} · ${groupLabel(o.type.groupKey)}`} autoHighlight>
                  <ComboboxInput id={`type-${recordId}`} placeholder="Search reply types" className="w-full" />
                  <ComboboxContent>
                    <ComboboxEmpty>No reply type matches.</ComboboxEmpty>
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
                  <div className="text-sm" data-testid="type-outcome">
                    {outcome ? (
                      <ul className="grid gap-0.5">
                        <li>{outcome.replyDraft}</li>
                        <li>{outcome.followUps}</li>
                        <li>{outcome.contact}</li>
                      </ul>
                    ) : outcomeError ? (
                      <p className="text-destructive">{outcomeError}</p>
                    ) : (
                      <p className="text-muted-foreground">Checking what the change does…</p>
                    )}
                  </div>
                )}
              </Field>
              {asksStop && (
                <FieldSet data-testid="type-stop">
                  <FieldLegend variant="label">Stop contacting {personName} too?</FieldLegend>
                  <FieldDescription>{stopScope.description} Only change the type stops nothing.</FieldDescription>
                  {stopScope.fields}
                </FieldSet>
              )}
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
                    <FieldDescription>Existing customers stay locked so the AI cannot move them to another group. You can still change the type.</FieldDescription>
                  </FieldContent>
                </Field>
              )}
            </FieldGroup>
      </ConfirmDialog>
    </>
  );
}
