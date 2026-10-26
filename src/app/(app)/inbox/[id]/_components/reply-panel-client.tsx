"use client";

import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ReachFlag } from "@/components/shell/reach-flag";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import type { ReplyPanel } from "@/contexts/conversations/application/reply-management";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { categorySourceLabel, draftStatusLabel } from "../../labels";
import { openStopContacting } from "./next-step-client";
import { registerDraftEdits } from "../_lib/draft-edits";
import type { NextInQueue } from "../_lib/next-queue";
import { ReplyComposer } from "./reply-composer-client";

const HOLD_TEXT: Record<string, string> = {
  protected_customer: "The person is locked as Existing customer.",
  protected_stage: "The proposal moves the person to a lower position.",
  requires_review: "This category always needs a person to confirm.",
  low_confidence: "Confidence is below the auto-apply threshold.",
};

type Panel = Omit<ReplyPanel, "draft" | "knownCcs"> & { knownCcs: Array<Omit<ReplyPanel["knownCcs"][number], "lastSeenAt"> & { lastSeenAt: string }>; draft: (Omit<NonNullable<ReplyPanel["draft"]>, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string }) | null };

export function ReplyPanelClient({ panel, next, fromQueue }: { panel: Panel; next: NextInQueue | null; fromQueue: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const draft = panel.draft;
  const saved = draft ? (draft.editedBodyText ?? draft.aiBodyText ?? "") : "";
  const [body, setBody] = useState(saved);
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [seenRevision, setSeenRevision] = useState(draft ? `${draft.id}:${draft.revision}` : "");
  const [cc, setCc] = useState<string[]>(draft?.cc ?? []);
  const [note, setNote] = useState("");
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // An out-of-date draft cannot send. "Edit and send anyway" copies its text into the composer as a new draft.
  const [editStale, setEditStale] = useState(false);
  const key = useRef<string>("");

  // A new draft or a revision saved elsewhere replaces the editor text.
  const currentRevision = draft ? `${draft.id}:${draft.revision}` : "";
  if (currentRevision !== seenRevision) {
    setSeenRevision(currentRevision);
    setBody(saved);
    setSubject(draft?.subject ?? "");
    setCc(draft?.cc ?? []);
    setEditStale(false);
  }

  const ccDirty = draft !== null && [...cc].sort().join(",") !== [...draft.cc].sort().join(",");
  const dirty = draft !== null && (body.trim() !== saved.trim() || subject.trim() !== (draft.subject ?? "").trim() || ccDirty);

  // Next step's controls retire the open draft. They save these edits first, so the out-of-date draft keeps what was typed.
  const edits = useRef({ draft, dirty, body, subject, cc });
  useEffect(() => {
    edits.current = { draft, dirty, body, subject, cc };
  });
  useEffect(
    () =>
      registerDraftEdits(async () => {
        const { draft: open, dirty: changed, body: text, subject: line, cc: copies } = edits.current;
        if (!open || !changed || open.status !== "awaiting_review") return null;
        const result = await callApi(`/api/drafts/${open.id}`, "PATCH", { revision: open.revision, subject: line.trim() || null, bodyText: text, cc: copies });
        return result.ok ? null : (result.error ?? "Try again.");
      }),
    [],
  );
  const composerBlocked = panel.suppressed ? "This address is on the suppression list." : panel.doNotContact ? "This person is marked do not contact." : panel.recipient === null ? "This person has no email address." : null;
  const composerSubject = panel.lastSubject ? (/^re:/i.test(panel.lastSubject) ? panel.lastSubject : `Re: ${panel.lastSubject}`) : "";
  const composer = <ReplyComposer conversationId={panel.conversationId} defaultSubject={composerSubject} knownCcs={panel.knownCcs} disabledReason={composerBlocked} />;

  async function run<T>(name: string, call: () => Promise<{ ok: boolean; data: T | null; error: string | null }>): Promise<T | null> {
    setBusy(name);
    setError(null);
    const result = await call();
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    router.refresh();
    return result.data;
  }

  /** A decision taken here: true once it is saved, whatever the response carries. */
  async function decide(name: string, call: () => Promise<{ ok: boolean; data: unknown; error: string | null }>, done: string) {
    setBusy(name);
    setError(null);
    const result = await call();
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setDecided(done);
    router.refresh();
  }

  const classification = panel.classification;
  const held = classification?.status === "proposed" && classification.current;
  // An applied change nobody has looked at waits for "Looks right", as it does on the Actions row.
  const unreviewed = classification?.status === "auto_applied" && !classification.acknowledged;
  // A suggestion to accept, a change to look at or a stop request to confirm needs a decision, so the classification
  // section opens by itself, and moves above the reply while no draft waits for approval.
  const classificationNeedsYou = Boolean(held && classification.proposed) || Boolean(unreviewed) || Boolean(classification?.stopRequested && !panel.suppressed);
  const classificationFirst = classificationNeedsYou && draft?.status !== "awaiting_review";
  // After a decision taken here, the next item of the queue is one tap away, as after a send.
  const [decided, setDecided] = useState<string | null>(null);
  // Hand-typing starts folded while the AI can write the draft; with no AI, or once asked for, it is open.
  const [composeOpen, setComposeOpen] = useState(false);
  const composerFolded = panel.aiConfigured && !panel.answered && !composeOpen;

  async function discard() {
    if (!draft) return;
    const result = await callApi(`/api/drafts/${draft.id}/discard`, "POST");
    if (!result.ok) throw new Error(result.error ?? "The draft was not discarded. Try again.");
    router.refresh();
  }

  async function approve() {
    if (!draft) return;
    setBusy("send");
    setError(null);
    let revision = draft.revision;
    if (dirty) {
      const saveResult = await callApi<{ revision: number }>(`/api/drafts/${draft.id}`, "PATCH", { revision, subject: subject.trim() || null, bodyText: body, cc });
      if (!saveResult.ok || !saveResult.data) {
        setBusy(null);
        setError(saveResult.error);
        return;
      }
      revision = saveResult.data.revision;
    }
    key.current ||= crypto.randomUUID();
    const result = await callApi<{ status: string; error?: string }>(`/api/drafts/${draft.id}/send`, "POST", { revision, idempotencyKey: key.current });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
    } else if (result.data && result.data.status !== "sent") {
      // A refused or blocked send is final for this key; the next click is a new decision.
      if (result.data.status !== "delivery_uncertain") key.current = "";
      setError(result.data.error ?? (result.data.status === "in_progress" ? "This send is already in progress." : "The reply was not sent."));
    }
    router.refresh();
  }

  const classificationCard = (
    <>
      {/* The AI's reading of the last reply. Changing the category lives in one place, Change category under Next step. */}
      <Card>
        <details open={classificationNeedsYou} data-testid="classification" className="group">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-(--card-spacing) text-sm font-semibold outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground transition-transform duration-(--duration-panel) ease-out group-open:rotate-90" />
            Classification
            {panel.category ? (
              <Badge variant="secondary" data-testid="category-chip">
                {panel.category.name} ({categorySourceLabel(panel.category.source)})
              </Badge>
            ) : (
              <Badge variant="outline">Not classified</Badge>
            )}
            {panel.suppressed && <ReachFlag kind="suppressed" />}
            {panel.doNotContact && <ReachFlag kind="do_not_contact" />}
          </summary>
          <div className="grid gap-3 px-(--card-spacing) pt-3 text-sm">
            {/* Confidence and reasoning belong to the reading they describe: the held suggestion when there is one. */}
            {classification && !held && classification.status !== "failed" && (classification.reasoning || classification.confidence != null) && (
              <p className="text-muted-foreground">
                {classification.confidence != null && `${Math.round(classification.confidence * 100)}% confident. `}
                {classification.reasoning}
              </p>
            )}
            {classification?.status === "failed" && <p className="text-destructive">Classification failed: {classification.error}</p>}
            {!classification && !panel.category && <p className="text-muted-foreground">{panel.aiConfigured ? "Waiting for the next AI run. Change category under Next step sets one yourself." : `${panel.aiOff} Change category under Next step sets one yourself.`}</p>}
            {held && classification.proposed && (
              <div className="grid gap-2 rounded-lg bg-muted/40 p-3" data-testid="proposal">
                <div>
                  AI suggests <strong>{classification.proposed.name}</strong>
                  {classification.confidence != null && ` (${Math.round(classification.confidence * 100)}% confident)`}. {classification.holdReason ? HOLD_TEXT[classification.holdReason] : ""}
                </div>
                {classification.reasoning && <p className="text-muted-foreground">{classification.reasoning}</p>}
                <div>
                  <Button size="sm" variant={classificationFirst ? "default" : "outline"} disabled={busy !== null} onClick={() => decide("accept", () => callApi(`/api/inbox/${panel.conversationId}/reply-type`, "POST", { replyTypeKey: null, expectedContextVersion: panel.contextVersion }), "Suggestion accepted.")}
                  >
                    Accept suggestion
                  </Button>
                </div>
              </div>
            )}
            {unreviewed && classification && (
              <div className="grid gap-2 rounded-lg bg-muted/40 p-3" data-testid="review-change">
                <p>The AI set this category. If it is wrong, use Change category under Next step.</p>
                <div>
                  <Button
                    size="sm"
                    // Under a draft that waits for approval, Approve and send stays the one filled button.
                    variant={classificationFirst ? "default" : "outline"}
                    disabled={busy !== null}
                    onClick={() => decide("ack", () => callApi(`/api/reply-type-picks/${classification.id}/acknowledge`, "POST"), "Marked as looked at.")}
                  >
                    Looks right
                  </Button>
                </div>
              </div>
            )}
            {decided && (
              <div role="status" className="flex flex-wrap items-center gap-2" data-testid="decided">
                <span>{decided}</span>
                {fromQueue && next && (
                  <Link href={next.href} className={cn(buttonVariants({ size: "sm" }), "max-sm:h-11")} data-testid="decided-next" aria-keyshortcuts="]">
                    Next: {next.name}
                  </Link>
                )}
              </div>
            )}
            {classification?.stopRequested && !panel.suppressed && (
              <div className="grid gap-2 rounded-lg border border-destructive/40 p-3" data-testid="stop-banner">
                <div>The sender appears to ask us to stop contacting them. Nothing stops until you confirm.</div>
                {/* The one stop flow is Next step's Stop contacting, which asks how far the stop reaches and confirms it. */}
                {!panel.doNotContact && (
                  <div>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={openStopContacting}>
                      Stop contacting…
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </details>
      </Card>
    </>
  );

  return (
    <div className="grid gap-4" data-testid="reply-panel">
      {classificationFirst && classificationCard}
      {/* overflow-visible lets the action bar stick to the bottom of the screen while the card is taller than the view. */}
      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            Reply
            {draft && (
              // Out of date is uncertain, not an error: the warning hue on its icon, never a red fill.
              <Badge variant="outline" data-testid="draft-status">
                {draft.status === "stale" && <TriangleAlertIcon aria-hidden className="text-warning" />}
                {draftStatusLabel(draft.status)}
              </Badge>
            )}
            {draft?.regeneratedFrom && <Badge variant="outline">Regenerated</Badge>}
          </CardTitle>
          <CardDescription>To {panel.recipient ?? "no address"}</CardDescription>
        </CardHeader>
        <CardContent
          className="grid gap-3"
          onKeyDown={(event) => {
            // Ctrl or Cmd with Enter approves from the subject or the message, the way a mail client sends. It is the same decision
            // as the button, with the same idempotency key, and it does nothing while a request runs or the message is empty.
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
            if (draft?.status === "stale" && !editStale) {
              event.preventDefault();
              setError("This draft is out of date. Regenerate it, or edit it and send it as a new draft.");
              return;
            }
            if (draft?.status !== "awaiting_review" || busy !== null || body.trim() === "" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void approve();
          }}
        >
          {!draft && !panel.aiConfigured && (
            <div className="grid gap-2 text-sm" data-testid="ai-not-configured">
              <p>{panel.aiOff} Until then, write the reply yourself below.</p>
              {panel.canManageAi && (
                <div>
                  <Link href="/settings/integrations" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                    Open integrations
                  </Link>
                </div>
              )}
            </div>
          )}
          {!draft && panel.aiConfigured && (
            <div className="grid gap-2 text-sm">
              <p>{panel.answered ? "This message has been answered." : "No draft yet."}</p>
              {!panel.answered && (
                <div>
                  <Button size="sm" disabled={busy !== null || !panel.canGenerate} onClick={() => run("draft", () => callApi(`/api/inbox/${panel.conversationId}/draft`, "POST"))}>
                    {busy === "draft" ? "Writing…" : "Write a draft"}
                  </Button>
                </div>
              )}
            </div>
          )}
          {(!draft || draft.status === "sent") &&
            (!draft && composerFolded ? (
              <div>
                <Button size="sm" variant="ghost" onClick={() => setComposeOpen(true)} data-testid="write-yourself">
                  Write it yourself
                </Button>
              </div>
            ) : (
              composer
            ))}

          {draft?.status === "stale" && (
            <div className="grid gap-3" data-testid="stale-draft">
              <p className="text-sm">{draft.error ?? "The thread or the reply category changed after this draft was written."}</p>
              {editStale ? (
                <ReplyComposer
                  conversationId={panel.conversationId}
                  defaultSubject={draft.subject ?? composerSubject}
                  defaultBody={saved}
                  title="Edit the draft as a new reply"
                  knownCcs={panel.knownCcs}
                  disabledReason={composerBlocked}
                />
              ) : (
                <p className="line-clamp-4 rounded-lg bg-muted/40 p-3 text-sm whitespace-pre-wrap text-muted-foreground" data-testid="stale-preview">
                  {saved || "The draft is empty."}
                </p>
              )}
              {showRegenerate && (
                <div className="grid gap-1">
                  <Label htmlFor="regen-note">What should change? (optional)</Label>
                  <Input id="regen-note" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              )}
            </div>
          )}

          {draft && (draft.status === "awaiting_review" || draft.status === "failed") && (
            <>
              {draft.status === "failed" && <p className="text-sm text-destructive">This draft cannot be sent. Regenerate or discard it.</p>}
              <div className="grid gap-1">
                <Label htmlFor="draft-subject">Subject</Label>
                <Input id="draft-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={draft.status !== "awaiting_review"} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="draft-body">Message</Label>
                <Textarea id="draft-body" className="min-h-48" value={body} onChange={(e) => setBody(e.target.value)} disabled={draft.status !== "awaiting_review"} />
              </div>
              {panel.knownCcs.length > 0 && (
                <fieldset className="grid gap-2 rounded-lg border p-3 text-sm" data-testid="cc-options" disabled={draft.status !== "awaiting_review"}>
                  <legend className="px-1 text-xs text-muted-foreground">CC on this reply</legend>
                  {panel.knownCcs.map((known) => (
                    <label key={known.email} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        data-testid="cc-option"
                        value={known.email}
                        checked={cc.includes(known.email)}
                        disabled={known.blocked !== null}
                        onChange={(e) => setCc((current) => (e.target.checked ? [...current, known.email] : current.filter((c) => c !== known.email)))}
                      />
                      <span>{known.email}</span>
                      {known.blocked && <ReachFlag kind={known.blocked} />}
                    </label>
                  ))}
                </fieldset>
              )}
              {showRegenerate && (
                <div className="grid gap-1">
                  <Label htmlFor="regen-note">What should change? (optional)</Label>
                  <Input id="regen-note" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              )}
            </>
          )}

          {/* One live region, present before its text changes, so "sent" is announced and not only shown. */}
          <div role="status" className="grid justify-items-start gap-2 text-sm empty:hidden" data-testid="reply-status">
            {draft?.status === "sending" && <p>Sending. Reload in a moment to see the result.</p>}
            {draft?.status === "sent" && (
              <>
                <p>The reply was sent and is in the thread above.</p>
                {/* From Actions the step after a send is the next item of that queue, one tap from here. */}
                {fromQueue &&
                  (next ? (
                    <Link href={next.href} className={cn(buttonVariants(), "max-sm:h-11")} data-testid="sent-next" aria-keyshortcuts="]">
                      Next: {next.name}
                    </Link>
                  ) : (
                    <p className="text-muted-foreground">Nothing else waits in this queue.</p>
                  ))}
              </>
            )}
          </div>
          {draft?.status === "delivery_uncertain" && (
            <UncertainBox
              draftId={draft.id}
              busy={busy !== null}
              onResolve={(outcome, text) => run("resolve", () => callApi(`/api/drafts/${draft.id}/resolve`, "POST", { outcome, note: text }))}
            />
          )}

          {panel.mailboxIssue && draft?.status === "awaiting_review" && <p className="text-sm text-destructive">{panel.mailboxIssue}</p>}
          {draft?.error && draft.status !== "delivery_uncertain" && draft.status !== "stale" && <p className="text-sm text-muted-foreground">{draft.error}</p>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        {draft && (draft.status === "awaiting_review" || draft.status === "failed" || draft.status === "stale") && (
          // The bar sticks to the bottom while a draft waits for approval; an out-of-date draft is short and keeps its bar in place.
          <CardFooter className={cn("flex flex-wrap gap-2 bg-card shadow-[0_-1px_0_0_var(--border)]", draft.status === "awaiting_review" && "sticky bottom-0 z-10")} data-testid="reply-actions">
            {draft.status === "awaiting_review" && (
              <Button disabled={busy !== null || body.trim() === ""} onClick={approve} aria-keyshortcuts="Control+Enter Meta+Enter">
                {busy === "send" ? "Sending…" : "Approve and send"}
              </Button>
            )}
            {draft.status === "awaiting_review" && dirty && (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => run("save", () => callApi(`/api/drafts/${draft.id}`, "PATCH", { revision: draft.revision, subject: subject.trim() || null, bodyText: body, cc }))}
              >
                Save edits
              </Button>
            )}
            <Button
              // One filled button on the page: a decision above the reply keeps it, and Regenerate leads only when it is the next step.
              variant={draft.status === "stale" && !classificationFirst ? "default" : "outline"}
              disabled={busy !== null || !panel.aiConfigured}
              onClick={async () => {
                if (!showRegenerate) return setShowRegenerate(true);
                if (await run("regen", () => callApi(`/api/drafts/${draft.id}/regenerate`, "POST", { note }))) {
                  setShowRegenerate(false);
                  setNote("");
                }
              }}
            >
              {busy === "regen" ? "Writing…" : showRegenerate ? "Regenerate now" : "Regenerate"}
            </Button>
            {draft.status === "stale" && !editStale && (
              <Button variant="outline" disabled={busy !== null} onClick={() => setEditStale(true)}>
                Edit and send anyway
              </Button>
            )}
            <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>
              Discard
            </Button>
          </CardFooter>
        )}
      </Card>
      {draft && (
        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={`Discard the draft reply to ${panel.recipient ?? "this person"}?`}
          description="The draft is deleted and nothing was sent. You can write or generate a new reply afterward."
          confirmLabel="Discard draft"
          pendingLabel="Discarding..."
          destructive
          onConfirm={discard}
        />
      )}

      {!classificationFirst && classificationCard}
    </div>
  );
}

function UncertainBox({ busy, onResolve }: { draftId: string; busy: boolean; onResolve: (outcome: "delivered" | "not_delivered", note: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm" data-testid="uncertain-box">
      <p>The mail provider did not confirm this send. It may have gone out, so it will not be retried. Check the Sent folder of the mailbox, then mark what you found.</p>
      <Label htmlFor="resolve-note">How did you check?</Label>
      <Input id="resolve-note" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => onResolve("delivered", text)}>
          Confirm delivered
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !text.trim()} onClick={() => onResolve("not_delivered", text)}>
          Not delivered
        </Button>
      </div>
    </div>
  );
}
