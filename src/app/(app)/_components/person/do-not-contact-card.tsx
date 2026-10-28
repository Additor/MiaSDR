import type { ReactNode } from "react";
import { Time } from "@/components/shell/time";
import { suppressionReasonLabel } from "@/contexts/people/domain/reachability";
import { AsideSection } from "../record/record-header";
import { DncControl } from "./dnc-control";

/**
 * When and why a marked person was marked. An unmarked person has no line: what marking does is said in the control's
 * confirm step, where it applies.
 */
export function DoNotContactNote({ doNotContact, reason, setAt }: { doNotContact: boolean; reason: string | null; setAt: Date | string | null }) {
  if (!doNotContact) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Marked {setAt && <Time value={setAt} />}
      {reason ? `: ${reason}` : ""}.
    </p>
  );
}

/**
 * The stop control at the foot of every person side column (lead, contact, deal, Inbox thread): do not contact and the
 * suppression state. Deleting a lead or a contact lives in the header's More menu. The contact delete dialog can open
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
