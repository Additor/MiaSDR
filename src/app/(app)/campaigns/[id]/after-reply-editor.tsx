"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AFTER_REPLY_MODE_LABELS, type AfterReplyMode } from "@/contexts/conversations/after-reply/domain/after-reply";
import {
  blankFollowUp,
  DELAY_UNITS,
  delayToMinutes,
  formChanged,
  lockedNote,
  MAX_FOLLOW_UP_STEPS,
  parseTags,
  splitDelay,
  stepsFromApi,
  stepsPayload,
  validateSteps,
  type DelayUnit,
  type EditorStep,
  type StepFromApi,
  type StepIssue,
} from "./after-reply-form";

interface SaveResponse {
  stoppedRuns?: number;
  error?: string;
  code?: string;
  count?: number;
  issues?: Array<{ step?: number | null; message: string }>;
}

/** The server needs follow-ups in progress confirmed before it switches the setting off. */
class RunsInProgressError extends Error {
  constructor(readonly count: number) {
    super("Follow-ups are in progress.");
  }
}

class SaveError extends Error {
  constructor(
    message: string,
    readonly issues: StepIssue[] = [],
  ) {
    super(message);
  }
}

async function putAfterReply(campaignId: string, body: unknown): Promise<SaveResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/campaigns/${campaignId}/after-reply`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new SaveError("Could not reach the server.");
  }
  const data = (await response.json().catch(() => null)) as SaveResponse | null;
  if (response.ok) return data ?? {};
  if (response.status === 409 && data?.code === "runs_in_progress") throw new RunsInProgressError(data.count ?? 0);
  throw new SaveError(
    data?.error ?? "Something went wrong. Try again.",
    (data?.issues ?? []).map((i) => ({ step: i.step ?? null, message: i.message })),
  );
}

/**
 * The After a reply form of a campaign: the mode and, for AI drafts, the reply step and the follow-ups. Save stores and
 * publishes in one step. The AI writes each draft and a person approves every message, so nothing here sends.
 */
export function AfterReplyEditor({
  campaignId,
  mode: savedMode,
  steps: savedSteps,
  supported,
  lockedReason,
  personal,
  inProgress,
}: {
  campaignId: string;
  mode: AfterReplyMode;
  steps: StepFromApi[];
  supported: boolean;
  lockedReason: string | null;
  personal: boolean;
  /** Follow-ups running or paused now, counted when the page loaded. */
  inProgress: number;
}) {
  const router = useRouter();
  const saved = { mode: savedMode, steps: stepsFromApi(savedSteps) };
  const [mode, setMode] = useState<AfterReplyMode>(supported ? savedMode : "handoff");
  const [steps, setSteps] = useState<EditorStep[]>(saved.steps);
  const [units, setUnits] = useState<DelayUnit[]>(() => saved.steps.map((s) => splitDelay(s.delayMinutes).unit));
  /** The wait as typed, per step. It lives beside the unit so the field always shows what the person entered in the unit they picked. */
  const [amounts, setAmounts] = useState<string[]>(() => saved.steps.map((s) => String(splitDelay(s.delayMinutes).amount)));
  const [tagText, setTagText] = useState<string[]>(() => saved.steps.map((s) => s.knowledgeTags.join(", ")));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<StepIssue[]>([]);
  /** The number of follow-ups the person is asked to stop, or null while no confirmation is open. */
  const [confirmStop, setConfirmStop] = useState<number | null>(null);

  const dirty = formChanged({ mode, steps, saved });
  const note = lockedNote(lockedReason, personal);
  const aiOn = mode === "ai_drafts";

  function update(index: number, patch: Partial<EditorStep>) {
    setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  // The first step is always the reply, so moving swaps only follow-ups.
  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (index < 1 || target < 1 || target >= steps.length) return;
    const swap = <T,>(list: T[]) => {
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    };
    setSteps(swap);
    setUnits(swap);
    setAmounts(swap);
    setTagText(swap);
  }

  function remove(index: number) {
    setSteps((all) => all.filter((_, i) => i !== index));
    setUnits((all) => all.filter((_, i) => i !== index));
    setAmounts((all) => all.filter((_, i) => i !== index));
    setTagText((all) => all.filter((_, i) => i !== index));
  }

  function add() {
    const blank = blankFollowUp();
    const { amount, unit } = splitDelay(blank.delayMinutes);
    setSteps((all) => [...all, blank]);
    setUnits((all) => [...all, unit]);
    setAmounts((all) => [...all, String(amount)]);
    setTagText((all) => [...all, ""]);
  }

  function setTags(index: number, text: string) {
    setTagText((all) => all.map((t, i) => (i === index ? text : t)));
    update(index, { knowledgeTags: parseTags(text) });
  }

  /** Sends the form. Throws RunsInProgressError or SaveError; the caller decides where the message shows. */
  async function submit(confirmStopRuns: boolean) {
    const body = mode === "ai_drafts" ? { mode, steps: stepsPayload(steps) } : { mode, ...(confirmStopRuns ? { confirmStopRuns: true } : {}) };
    const result = await putAfterReply(campaignId, body);
    toast.success(mode === "ai_drafts" ? "Saved. New replies use these follow-ups." : result.stoppedRuns ? `Follow-ups switched off. ${result.stoppedRuns} stopped.` : "Saved. Replies go to the Inbox.");
    router.refresh();
  }

  async function onSave() {
    setError(null);
    setIssues([]);
    if (aiOn) {
      const found = validateSteps(steps);
      if (found.length > 0) {
        setIssues(found);
        return;
      }
    } else if (savedMode === "ai_drafts" && inProgress > 0) {
      // Ask before the request: switching off stops the follow-ups already running.
      setConfirmStop(inProgress);
      return;
    }
    setPending(true);
    try {
      await submit(false);
    } catch (e) {
      if (e instanceof RunsInProgressError) setConfirmStop(e.count);
      else if (e instanceof SaveError) {
        setError(e.message);
        setIssues(e.issues);
      } else setError("Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-3" disabled={pending}>
        <legend className="sr-only">After a reply</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name={`after-reply-${campaignId}`} className="mt-1" checked={!aiOn} onChange={() => setMode("handoff")} />
          <span className="grid gap-0.5">
            <span className="font-medium">{AFTER_REPLY_MODE_LABELS.handoff}</span>
            <span className="text-muted-foreground">The sequence stops for that lead and the reply waits in the Inbox.</span>
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${supported ? "" : "opacity-60"}`}>
          <input type="radio" name={`after-reply-${campaignId}`} className="mt-1" checked={aiOn} disabled={!supported} onChange={() => setMode("ai_drafts")} />
          <span className="grid gap-0.5">
            <span className="font-medium">{AFTER_REPLY_MODE_LABELS.ai_drafts}</span>
            <span className="text-muted-foreground">The AI writes each draft. You approve every message before it sends.</span>
          </span>
        </label>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </fieldset>

      {aiOn && (
        <ol className="grid divide-y border-y">
          {steps.map((step, index) => {
            const amount = amounts[index] ?? "";
            const unit = units[index] ?? "days";
            const stepIssues = issues.filter((i) => i.step === index + 1);
            return (
              <li key={index} className="grid gap-3 py-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {index + 1}. {index === 0 ? "Reply to their answer" : "Follow-up"}
                  </p>
                  {index > 0 && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Move step ${index + 1} up`} disabled={pending || index < 2} onClick={() => move(index, -1)}>
                        <ArrowUpIcon />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Move step ${index + 1} down`} disabled={pending || index >= steps.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDownIcon />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove step ${index + 1}`} disabled={pending} onClick={() => remove(index)}>
                        <Trash2Icon />
                      </Button>
                    </div>
                  )}
                </div>
                {index > 0 && (
                  <div className="grid gap-2">
                    <Label htmlFor={`ar-delay-${index}`}>Wait after the previous message</Label>
                    <div className="flex gap-2">
                      <Input
                        id={`ar-delay-${index}`}
                        type="number"
                        min={1}
                        value={amount}
                        disabled={pending}
                        className="w-24"
                        aria-invalid={stepIssues.some((i) => i.message.includes("wait")) || undefined}
                        onChange={(e) => {
                          setAmounts((all) => all.map((a, i) => (i === index ? e.target.value : a)));
                          update(index, { delayMinutes: delayToMinutes(Number(e.target.value), unit) });
                        }}
                      />
                      <Select
                        items={DELAY_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                        value={unit}
                        disabled={pending}
                        onValueChange={(next) => {
                          if (!next) return;
                          setUnits((all) => all.map((u, i) => (i === index ? (next as DelayUnit) : u)));
                          update(index, { delayMinutes: delayToMinutes(Number(amount), next as DelayUnit) });
                        }}
                      >
                        <SelectTrigger className="w-32" aria-label={`Unit for step ${index + 1}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DELAY_UNITS.map((u) => (
                            <SelectItem key={u.value} value={u.value}>
                              {u.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <div className="grid gap-2">
                  <Label htmlFor={`ar-goal-${index}`}>Goal</Label>
                  <Textarea
                    id={`ar-goal-${index}`}
                    rows={3}
                    value={step.aiInstructions}
                    maxLength={8000}
                    disabled={pending}
                    aria-invalid={stepIssues.some((i) => i.message.includes("goal")) || undefined}
                    placeholder={index === 0 ? "Answer their question clearly and suggest a suitable next step." : "Ask whether they had a chance to look and offer a short call."}
                    onChange={(e) => update(index, { aiInstructions: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">The instruction the AI follows when it writes this message.</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`ar-tags-${index}`}>Knowledge tags (comma separated, optional)</Label>
                  <Input id={`ar-tags-${index}`} value={tagText[index] ?? ""} disabled={pending} placeholder="pricing, faq" onChange={(e) => setTags(index, e.target.value)} />
                </div>
                {index > 0 && (
                  <>
                    <div className="grid gap-2">
                      <Label htmlFor={`ar-subject-${index}`}>Starting subject (optional)</Label>
                      <Input id={`ar-subject-${index}`} value={step.subjectTemplate} maxLength={500} disabled={pending} onChange={(e) => update(index, { subjectTemplate: e.target.value })} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={`ar-body-${index}`}>Starting text (optional)</Label>
                      <Textarea id={`ar-body-${index}`} rows={4} value={step.bodyTemplate} maxLength={20000} disabled={pending} onChange={(e) => update(index, { bodyTemplate: e.target.value })} />
                      <p className="text-xs text-muted-foreground">
                        The AI starts from this text. Use {"{{firstName}}"} and {"{{company}}"} for lead fields.
                      </p>
                    </div>
                  </>
                )}
                {stepIssues.map((i) => (
                  <p key={i.message} role="alert" className="text-sm text-destructive">
                    {i.message}
                  </p>
                ))}
              </li>
            );
          })}
        </ol>
      )}

      {issues
        .filter((i) => i.step === null)
        .map((i) => (
          <p key={i.message} role="alert" className="text-sm text-destructive">
            {i.message}
          </p>
        ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {aiOn && (
          <Button variant="outline" disabled={pending || steps.length >= MAX_FOLLOW_UP_STEPS} onClick={add}>
            <PlusIcon /> Add follow-up
          </Button>
        )}
        <Button onClick={() => void onSave()} disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {dirty && !pending && <p className="text-xs text-muted-foreground">Unsaved changes.</p>}
      </div>

      <ConfirmDialog
        open={confirmStop !== null}
        onOpenChange={(open) => !open && setConfirmStop(null)}
        title={`Stop ${confirmStop ?? 0} ${confirmStop === 1 ? "follow-up" : "follow-ups"} in progress?`}
        description="Switching off stops the follow-ups that are running, and the AI writes no more drafts for them. Your steps stay saved."
        confirmLabel="Switch off follow-ups"
        cancelLabel="Keep following up"
        pendingLabel="Switching off…"
        destructive
        onConfirm={() => submit(true)}
      />
    </div>
  );
}
