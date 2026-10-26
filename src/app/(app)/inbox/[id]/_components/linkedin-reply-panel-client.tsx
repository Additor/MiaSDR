"use client";

import { CircleHelpIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { ReachFlag } from "@/components/shell/reach-flag";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { LinkedInReplyPanelView } from "@/contexts/conversations/application/linkedin-reply";
import { callApi } from "@/app/_lib/api-client";
import { draftStatusLabel } from "../../labels";

type SendResult = { status: string; error?: string | null };

/**
 * Composer for a LinkedIn chat. An AI draft fills the box; the person edits it and presses Send, which is the approval.
 * Nothing goes out without it.
 */
export function LinkedInReplyPanelClient({ panel }: { panel: LinkedInReplyPanelView }) {
  const router = useRouter();
  const draft = panel.draft;
  const [text, setText] = useState(draft?.status === "awaiting_review" ? draft.text : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef("");
  const blocked = panel.issue !== null || panel.doNotContact;
  const stale = draft?.status === "stale";
  const [note, setNote] = useState("");
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  async function run(action: () => Promise<{ ok: boolean; error?: string | null }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) return setError(result.error ?? "The request failed.");
    router.refresh();
  }

  async function send() {
    setBusy(true);
    setError(null);
    // One key per decision: a double click or a retry after a lost response replays the same send.
    key.current ||= crypto.randomUUID();
    const result = await callApi<SendResult>(`/api/inbox/${panel.conversationId}/linkedin-reply`, "POST", {
      text,
      idempotencyKey: key.current,
      // Approving the AI draft names the draft and the revision the person reviewed, so a stale or replaced draft cannot go out.
      ...(draft?.status === "awaiting_review" ? { draftId: draft.id, revision: draft.revision } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      // A refusal before the claim wrote nothing, so the next click is a new decision.
      key.current = "";
      setError(result.error);
      return;
    }
    const data = result.data;
    if (data?.status === "sent") {
      key.current = "";
      setText("");
    } else if (data?.status === "delivery_uncertain") {
      setText("");
    } else {
      key.current = "";
      setError(data?.error ?? "The reply was not sent.");
    }
    router.refresh();
  }

  async function discard() {
    if (!draft) return;
    const result = await callApi(`/api/drafts/${draft.id}/discard`, "POST");
    if (!result.ok) throw new Error(result.error ?? "The draft was not discarded. Try again.");
    router.refresh();
  }

  async function resolve(outcome: "delivered" | "not_delivered", note: string) {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const result = await callApi(`/api/drafts/${draft.id}/resolve`, "POST", { outcome, note });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  // overflow-visible on the card lets the action bar stick to the bottom of the screen while the card is taller than the view.
  return (
    <Card data-testid="linkedin-reply-panel" className="overflow-visible">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          Reply on LinkedIn
          {draft?.source === "ai" && draft.status === "awaiting_review" && <Badge variant="outline">AI draft</Badge>}
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
          <UncertainBox busy={busy} onResolve={resolve} />
        ) : draft?.status === "sending" ? (
          <p className="text-sm">A reply is being sent. Reload in a moment to see the result.</p>
        ) : (
          <div className="grid gap-1">
            {stale && <p className="text-sm">This draft may be out of date: a newer message arrived after it was written. Regenerate or discard it.</p>}
            {!draft && !panel.canGenerate && panel.aiOff && !panel.doNotContact && <p className="text-sm text-muted-foreground">{panel.aiOff} Until then, write the message yourself below.</p>}
            {!draft && panel.canGenerate && !panel.doNotContact && (
              <div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => callApi(`/api/inbox/${panel.conversationId}/draft`, "POST"))}>
                  {busy ? "Writing…" : "Write a draft"}
                </Button>
              </div>
            )}
            <Label htmlFor="li-reply">Message{panel.recipient ? ` to ${panel.recipient}` : ""}</Label>
            <Textarea id="li-reply" className="min-h-32" value={stale ? (draft?.text ?? "") : text} onChange={(e) => setText(e.target.value)} disabled={blocked || busy || stale} />
            {showRegenerate && (
              <>
                <Label htmlFor="li-regen-note">What should change? (optional)</Label>
                <Input id="li-regen-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </>
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
            <Button disabled={blocked || busy || text.trim() === ""} onClick={send}>
              {busy ? "Sending…" : "Send"}
            </Button>
          )}
          {draft && (
            <>
              <Button
                variant="outline"
                disabled={busy || !panel.canGenerate}
                onClick={async () => {
                  if (!showRegenerate) return setShowRegenerate(true);
                  await run(() => callApi(`/api/drafts/${draft.id}/regenerate`, "POST", { note }));
                  setShowRegenerate(false);
                  setNote("");
                }}
              >
                {showRegenerate ? "Regenerate now" : "Regenerate"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDiscard(true)}>
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
          onConfirm={discard}
        />
      )}
    </Card>
  );
}

function UncertainBox({ busy, onResolve }: { busy: boolean; onResolve: (outcome: "delivered" | "not_delivered", note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    // An unconfirmed send is uncertain: the warning hue on the icon and the lead words only, no frame.
    <div className="grid gap-2 text-sm" data-testid="uncertain-box">
      <div className="flex items-start gap-2">
        <CircleHelpIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          <strong className="font-medium text-warning">Not confirmed.</strong> LinkedIn did not confirm this message. It may have gone out, so it will not be sent again. Open the chat on LinkedIn, then mark what you found.
        </p>
      </div>
      <Label htmlFor="li-resolve-note">How did you check?</Label>
      <Input id="li-resolve-note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !note.trim()} onClick={() => onResolve("delivered", note)}>
          Confirm delivered
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={() => onResolve("not_delivered", note)}>
          Not delivered
        </Button>
      </div>
    </div>
  );
}
