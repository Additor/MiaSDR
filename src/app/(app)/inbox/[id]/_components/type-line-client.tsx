"use client";

import { ChevronRightIcon, CircleHelpIcon, LockIcon, PlugIcon, SparklesIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import type { HoldReason } from "@/contexts/conversations/domain/reply-type";
import { callApi } from "@/app/_lib/api-client";
import { StateTip } from "@/app/(app)/_components/person/state-tip";
import type { NextInQueue } from "../_lib/next-queue";
import { replyTypeSourceTip } from "../../labels";
import { afterSavingEdits } from "../_lib/draft-edits";
import { confidenceText, decisionKey, decisionView, holdText, LOOKS_RIGHT_DONE, type DecisionKind } from "../_lib/type-line";
import { ChangeTypeButton, type TypeOption } from "./change-type-button";
import { openStopContacting, type StopTarget } from "./stop-contacting";

export interface TypeLineProps {
  recordId: string;
  conversationId: string;
  contextVersion: number;
  personName: string;
  /** The record's reply type, or null before anything picked one. */
  type: { name: string; group: string | null; rules: string | null; source: string | null; locked: boolean } | null;
  currentReplyTypeId: string | null;
  types: TypeOption[];
  /** The AI's pick of the latest reply, behind Why. */
  why: { failed: string | null; name: string | null; group: string | null; confidence: number | null; reasoning: string | null } | null;
  decision: { kind: DecisionKind; pickId: string; proposed: string | null; proposedGroup: string | null; confidence: number | null; holdReason: HoldReason | null } | null;
  draftAwaits: boolean;
  closed: boolean;
  stop: StopTarget & { doNotContact: boolean };
  /** The item after this one in the Actions view the thread came from, null when nothing else waits. Absent outside a queue. */
  next?: NextInQueue | null;
}

const named = (name: string | null, group: string | null) => [name, group].filter(Boolean).join(" · ");

/**
 * One line under the latest message, the same for email and LinkedIn: who set the reply type (sparkle or person), the type,
 * its group and what its rules do, Why for the AI's reasoning, and Change type. It opens in place, under the same line, when
 * the AI's pick waits for a person: a held pick (Accept), an applied pick nobody checked (Looks right) or a stop request
 * (Review stop request, which opens Stop contacting). A held pick whose type an admin archived since leads with Change type.
 * The button is filled unless a draft waits for approval, so one filled button leads the page. An answer hides the decision
 * at once, so a second click cannot send it again while the refresh lands.
 */
export function TypeLineClient(props: TypeLineProps) {
  const { type, decision, why } = props;
  const router = useRouter();
  const whyId = useId();
  const [whyOpen, setWhyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ key: string; text: string } | null>(null);
  const lead = props.draftAwaits ? "outline" : "default";
  const key = decisionKey(decision);
  const view = decisionView(key, settled);

  async function decide(call: () => Promise<{ ok: boolean; error: string | null; details: Record<string, unknown> | null }>, done: string) {
    if (busy || !key) return;
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      // Accepting a held stop request would only change the type: the server sends the person to Stop contacting.
      if (result.details?.code === "stop_review") return openStopContacting();
      return setError(result.error);
    }
    setSettled({ key, text: done });
    router.refresh();
  }

  const changeType = (variant: "link" | "outline" | "default") =>
    !props.closed && (
      <ChangeTypeButton
        recordId={props.recordId}
        conversationId={props.conversationId}
        personName={props.personName}
        contextVersion={props.contextVersion}
        currentReplyTypeId={props.currentReplyTypeId}
        replyTypeLocked={type?.locked ?? false}
        types={props.types}
        aiReading={why && !why.failed && why.name ? { name: named(why.name, why.group), confidence: why.confidence, reasoning: why.reasoning } : null}
        stop={props.stop}
        variant={variant}
      />
    );

  return (
    <div className="grid gap-2 text-sm" data-testid="type-line">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* Without a type the visible text names the reply type itself. */}
        {type && <span className="sr-only">Reply type: </span>}
        {type?.source && (
          <StateTip trigger={<span tabIndex={0} className="inline-flex rounded-sm text-muted-foreground focus-ring" data-testid="type-source" />} tip={replyTypeSourceTip(type.source)}>
            {type.source === "ai" ? <SparklesIcon aria-hidden className="size-3.5" /> : type.source === "integration" ? <PlugIcon aria-hidden className="size-3.5" /> : <UserIcon aria-hidden className="size-3.5" />}
          </StateTip>
        )}
        <span className={cn("font-medium", !type && "text-muted-foreground")} data-testid="type-name">
          {type ? named(type.name, type.group) : "No reply type yet"}
        </span>
        {/* On a phone the rules take their own line, so no separator starts a line. */}
        {type?.rules && (
          <span className="text-muted-foreground max-sm:order-last max-sm:basis-full">
            <span aria-hidden className="max-sm:hidden">
              ·{" "}
            </span>
            {type.rules}
          </span>
        )}
        {type?.locked && (
          <StateTip trigger={<span tabIndex={0} className="inline-flex rounded-sm text-muted-foreground focus-ring" data-testid="type-locked" />} tip="Locked as Existing customer. The AI cannot move this person to another group.">
            <LockIcon aria-hidden className="size-3.5" />
          </StateTip>
        )}
        {why && (
          <Button variant="ghost" size="xs" className="text-muted-foreground max-sm:h-11" aria-expanded={whyOpen} aria-controls={whyId} onClick={() => setWhyOpen((o) => !o)}>
            Why
            <ChevronRightIcon aria-hidden className={cn("transition-transform duration-(--duration-panel) ease-out", whyOpen && "rotate-90")} />
          </Button>
        )}
        {!view.showDecision && changeType("link")}
      </div>

      {why && (
        <p id={whyId} hidden={!whyOpen} className="max-w-prose text-muted-foreground" data-testid="type-why">
          {why.failed
            ? `The AI could not pick a type. ${why.failed}`
            : `The AI picked ${named(why.name, why.group) || "no type"}${why.confidence != null ? `, ${confidenceText(why.confidence)}` : ""}.${why.reasoning ? ` ${why.reasoning}` : ""}`}
        </p>
      )}

      {decision && view.showDecision && (
        <div className="grid gap-2" data-testid="type-decision">
          {decision.kind === "stop" ? (
            // A stop request is the AI's uncertain reading, not an error: the amber icon and lead words, no red frame.
            <div className="flex items-start gap-2">
              <CircleHelpIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                <strong className="font-medium text-warning">Possible stop request.</strong> {props.personName} seems to ask you to stop. Nothing stops until you choose.
              </p>
            </div>
          ) : decision.kind === "archived" ? (
            <p>
              The AI picked <strong className="font-medium">{named(decision.proposed, decision.proposedGroup)}</strong>, but an admin archived that type since. Choose another type.
            </p>
          ) : decision.kind === "held" ? (
            <p>
              The AI picked <strong className="font-medium">{named(decision.proposed, decision.proposedGroup)}</strong>
              {decision.confidence != null && `, ${confidenceText(decision.confidence)}`}. {holdText(decision.holdReason)}
            </p>
          ) : (
            <p>
              The AI applied this type{decision.confidence != null && `, ${confidenceText(decision.confidence)}`}, and it waits for your check.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {decision.kind === "stop" ? (
              <Button size="sm" variant={lead} className="max-sm:h-11" disabled={busy} onClick={openStopContacting}>
                Review stop request
              </Button>
            ) : decision.kind === "held" ? (
              <Button
                size="sm"
                variant={lead}
                className="max-sm:h-11"
                disabled={busy}
                // Accept retires the open draft, so the editor's unsaved edits are saved first.
                onClick={() => decide(() => afterSavingEdits(() => callApi(`/api/inbox/${props.conversationId}/reply-type`, "POST", { replyTypeKey: null, expectedContextVersion: props.contextVersion })), "AI pick accepted.")}
              >
                {busy ? "Accepting…" : decision.holdReason === "protected_customer" ? "Accept and unlock" : "Accept"}
              </Button>
            ) : decision.kind === "archived" ? null : (
              <Button size="sm" variant={lead} className="max-sm:h-11" disabled={busy} onClick={() => decide(() => callApi(`/api/reply-type-picks/${decision.pickId}/acknowledge`, "POST"), LOOKS_RIGHT_DONE)}>
                {busy ? "Saving…" : "Looks right"}
              </Button>
            )}
            {changeType(decision.kind === "archived" ? lead : "outline")}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {/* One live region, present before its text changes, so the outcome is announced and not only shown. */}
      <div role="status" className="flex flex-wrap items-center gap-2 empty:hidden" data-testid="type-status">
        {view.done && (
          <>
            <span>{view.done}</span>
            {props.next && (
              // Under a draft that waits for approval, Approve and send keeps the one filled button.
              <Link href={props.next.href} className={cn(buttonVariants({ size: "sm", variant: lead }), "max-sm:h-11")} data-testid="type-next" aria-keyshortcuts="]">
                Next: {props.next.name}
              </Link>
            )}
            {props.next === null && <span className="text-muted-foreground">Nothing else waits in this queue.</span>}
          </>
        )}
      </div>
    </div>
  );
}
