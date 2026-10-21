import type { ReactNode } from "react";
import { Time } from "@/components/shell/time";
import { suppressionReasonLabel } from "@/contexts/outreach/domain/reachability";
import { AsideSection } from "../record/record-header";
import { DncControl } from "./dnc-control";

/** What do not contact means for this person: when and why they were marked, or what marking them does. */
export function DoNotContactNote({ doNotContact, reason, setAt }: { doNotContact: boolean; reason: string | null; setAt: Date | string | null }) {
  return (
    <p className="text-sm text-muted-foreground">
      {doNotContact ? (
        <>
          Marked {setAt && <Time value={setAt} />}
          {reason ? `: ${reason}` : ""}. Email and LinkedIn sends skip this person, and campaigns do not add them.
        </>
      ) : (
        "Stops every channel, ends their campaign enrollments and retires open drafts."
      )}
    </p>
  );
}

/**
 * The stop controls at the foot of every person side column (lead, contact, deal, Inbox thread): do not contact, the
 * suppression state, and what the page adds below (the delete row, or the thread's reply handling). The contact delete dialog can open
 * the do not contact control here (`openDncControl`).
 */
export function DoNotContactCard({
  personId,
  doNotContact,
  reason,
  setAt,
  suppression,
  testId = "person-stop",
  children,
}: {
  personId: string;
  doNotContact: boolean;
  reason: string | null;
  /** ISO timestamp of the flag, or null when the person was never marked. */
  setAt: Date | string | null;
  suppression: { reason: string; note: string | null; date: string } | null;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <AsideSection title="Do not contact" testId={testId}>
      <DoNotContactNote doNotContact={doNotContact} reason={reason} setAt={setAt} />
      {suppression && (
        <p className="text-sm text-muted-foreground">
          Email address on the suppression list since <Time value={suppression.date} dateOnly /> ({suppressionReasonLabel(suppression.reason).toLowerCase()}
          {suppression.note ? `, ${suppression.note}` : ""}).
        </p>
      )}
      <DncControl personId={personId} doNotContact={doNotContact} />
      {children && <div className="grid gap-3 border-t pt-3 text-sm">{children}</div>}
    </AsideSection>
  );
}
