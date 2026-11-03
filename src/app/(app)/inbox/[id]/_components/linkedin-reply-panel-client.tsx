"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { ReachFlag } from "@/components/shell/reach-flag";
import { Spinner } from "@/components/shell/spinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { LinkedInReplyPanelView } from "@/contexts/conversations/application/linkedin-reply";
import { callApi } from "@/app/_lib/api-client";
import { draftStatusLabel } from "../../labels";
import { draftingAbove } from "../_lib/reply-panel";
import { SendingLine } from "./sending-line";
import { UncertainBox } from "./uncertain-box";
import { useDraftActions, useSendKey } from "./use-draft-actions";

type SendResult = { status: string; error?: string | null };

/**
 * Composer for a LinkedIn chat. An AI draft fills the box; the person edits it and presses Send, which is the approval.
 * Nothing goes out without it. Without a draft, `noDraft` says why the reply type writes none, and `drafting` that one is on
 * its way. A new draft, revision or status resets the text box to the stored draft; an error stays, so a refusal that reloads
 * the page is still read.
 */
export function LinkedInReplyPanelClient({ panel, noDraft, drafting }: { panel: LinkedInReplyPanelView; noDraft: string | null; drafting: boolean }) {
  const { busy, error, setError, work, refresh, requestDraft, regenerate, resolve, discard } = useDraftActions(panel.threadId);
  const draft = panel.draft;
  const [text, setText] = useState(draft?.status === "awaiting_review" ? draft.text : "");
  const working = busy !== null;
  const blocked = panel.issue !== null || panel.doNotContact;
  const stale = draft?.status === "stale";
  const [note, setNote] = useState("");
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const revision = draft ? `${draft.id}:${draft.revision}:${draft.status}` : "";
  const [seenRevision, setSeenRevision] = useState(revision);
  if (revision !== seenRevision) {
    setSeenRevision(revision);
    setText(draft?.status === "awaiting_review" ? draft.text : "");
    setShowRegenerate(false);
    setNote("");
  }
  const sendKey = useSendKey(revision);
  const draftingNext = draftingAbove(draft, drafting);

  function send() {
    return work("send", async () => {
      const result = await callApi<SendResult>(`/api/inbox/${panel.threadId}/linkedin-reply`, "POST", {
        text,
        idempotencyKey: sendKey.take(),
        // Approving the AI draft names the draft and the revision the person reviewed, so a stale or replaced draft cannot go out.
        ...(draft?.status === "awaiting_review" ? { draftId: draft.id, revision: draft.revision } : {}),
      });
      const keptKey = sendKey.settle(result);
      if (!result.ok) {
        setError(result.error);
        // Without an answer the send may have gone out: the reload shows it in the thread and empties the box.
        if (keptKey) refresh();
        return;
      }
      const data = result.data;
      if (data?.status === "sent" || data?.status === "delivery_uncertain") setText("");
      else setError(data?.error ?? (data?.status === "in_progress" ? "This send is already in progress." : "The reply was not sent."));
      refresh();
    });
  }

  // overflow-visible on the card lets the action bar stick to the bottom of the screen while the card is taller than the view.
  return (
    <Card data-testid="linkedin-reply-panel" className="overflow-visible">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          Reply on LinkedIn
          {draft?.source === "ai" && draft.status === "awaiting_review" && <Badge variant="outline">AI draft</Badge>}
          {draft?.writtenVia && <Badge variant="outline">Written by an agent ({draft.writtenVia})</Badge>}
          {stale && (
            // Out of date is uncertain, not an error: the warning hue on its icon, never a red fill.
            <Badge variant="outline">
              <TriangleAlertIcon aria-hidden className="text-warning" />
              {draftStatusLabel("stale")}
            </Badge>
          )}
          {panel.doNotContact && <ReachFlag kind="do_not_contact" />}
          {draft && draft.status !== "awaiting_review" && !stale && (
            <Badge variant="outline" data-testid="draft-status">
              {draftStatusLabel(draft.status)}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Sent as {panel.accountLabel}. Nothing goes out until you press Send. {panel.usedToday} of {panel.dailyLimit} messages used today.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {draft?.status === "delivery_uncertain" ? (
          <UncertainBox
            noteId="li-resolve-note"
            advice="LinkedIn did not confirm this message. It may have gone out, so it will not be sent again. Open the chat on LinkedIn, then mark what you found."
            busy={working}
            onResolve={(outcome, checked) => resolve(draft.id, outcome, checked)}
          />
        ) : draft?.status === "sending" ? (
          <div role="status" className="text-sm">
            <SendingLine stopped="A reply is being sent. Reload in a moment to see the result." />
          </div>
        ) : (
          <div className="stack-group">
            {draftingNext && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="drafting">
                <Spinner />
                Drafting…
              </p>
            )}
            {/* The stale reason the server stored, as the email panel shows it. */}
            {stale && (
              <p className="text-sm">
                {draft?.error ?? "This draft may be out of date: a newer message arrived after it was written."}{" "}
                {panel.markedDone ? "Discard it, or reopen reply handling to regenerate." : "Regenerate or discard it."}
              </p>
            )}
            {!draft && !panel.canGenerate && panel.aiOff && !panel.doNotContact && !panel.markedDone && <p className="text-sm text-muted-foreground">{panel.aiOff} Until then, write the message yourself below.</p>}
            {!draft && panel.canGenerate && !panel.doNotContact && drafting && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="no-draft">
                <Spinner />
                Drafting…
              </p>
            )}
            {!draft && panel.canGenerate && !panel.doNotContact && !drafting && (
              <div className="grid justify-items-start gap-2 text-sm" data-testid="no-draft">
                {noDraft && <p>{noDraft}</p>}
                <Button size="sm" variant="outline" touch disabled={working} onClick={requestDraft}>
                  {busy === "draft" ? "Writing…" : "Write a draft"}
                </Button>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="li-reply">Message{panel.recipient ? ` to ${panel.recipient}` : ""}</FieldLabel>
              <Textarea
                id="li-reply"
                className="min-h-32"
                value={stale ? (draft?.text ?? "") : text}
                onChange={(e) => {
                  // Other words are a new decision: a retry with the old key would replay the old send and drop them.
                  sendKey.drop();
                  setText(e.target.value);
                }}
                disabled={blocked || working || stale}
              />
            </Field>
            {showRegenerate && (
              <Field>
                <FieldLabel htmlFor="li-regen-note">What should change? (optional)</FieldLabel>
                <Input id="li-regen-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        {panel.doNotContact && <p className="text-sm text-destructive">This person is marked do not contact.</p>}
        {panel.issue && <p className="text-sm text-destructive">{panel.issue}</p>}
        {draft?.status === "awaiting_review" && draft.error && <p className="text-sm text-muted-foreground">Last attempt: {draft.error}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
      {draft?.status !== "delivery_uncertain" && draft?.status !== "sending" && (
        <CardFooter className="sticky bottom-0 z-10 flex flex-wrap gap-2 bg-card shadow-[0_-1px_0_0_var(--border)]" data-testid="reply-actions">
          {!stale && (
            <Button disabled={blocked || working || text.trim() === ""} onClick={send}>
              {busy === "send" ? "Sending…" : "Send"}
            </Button>
          )}
          {draft && (
            <>
              <Button
                variant="outline"
                // While a draft job writes the next draft, Regenerate stays off so it cannot add a second one.
                disabled={working || !panel.canGenerate || draftingNext}
                onClick={async () => {
                  if (!showRegenerate) return setShowRegenerate(true);
                  if (await regenerate(draft.id, draft.revision, note)) {
                    setShowRegenerate(false);
                    setNote("");
                  }
                }}
              >
                {showRegenerate ? "Regenerate now" : "Regenerate"}
              </Button>
              <Button variant="ghost" disabled={working} onClick={() => setConfirmDiscard(true)}>
                Discard
              </Button>
            </>
          )}
        </CardFooter>
      )}
      {draft && (
        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={`Discard the draft message to ${panel.recipient ?? "this person"}?`}
          description="The draft is deleted and nothing was sent. You can write or generate a new message afterward."
          confirmLabel="Discard draft"
          cancelLabel="Keep draft"
          pendingLabel="Discarding…"
          destructive
          onConfirm={() => discard(draft.id, draft.revision)}
        />
      )}
    </Card>
  );
}
