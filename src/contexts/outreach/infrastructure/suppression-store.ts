import { db } from "@/platform/db/client";
import type { ContactStop } from "../application/inbound-ports";
import type { SuppressionStore } from "../email/application/unsubscribe";

const TRIGGER_OF_REASON = { bounced: "bounce", unsubscribed: "unsubscribe", manual: "suppression" } as const;

/** A suppression as outreach raises it: one transaction through conversations' `stopContactTx`, which lists the address and ends what the trigger's row says. */
export const createSuppressionStore = (stop: ContactStop): SuppressionStore => ({
  suppressEmail: ({ organizationId, email, reason, note, addedInSettings }) =>
    db.transaction(async (tx) => {
      const { enrollments, added } = await stop.stopContactTx(tx, { organizationId, email }, { kind: TRIGGER_OF_REASON[reason], note, addedInSettings, now: new Date() });
      return { stopped: enrollments, added };
    }),
});
