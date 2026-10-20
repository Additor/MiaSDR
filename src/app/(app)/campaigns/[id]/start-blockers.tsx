import Link from "next/link";
import { blockerTab, campaignTabHref, CAMPAIGN_TAB_LABELS, type StartBlocker } from "@/contexts/outreach/domain/campaign-view";

/** The id of the list, which a disabled Start button names in `aria-describedby`. */
export const START_BLOCKERS_ID = "start-blockers";

/** Why Start is disabled. Each line links to the tab of this page that fixes it, or to the app settings when a mailbox or account is missing. */
export function StartBlockers({ blockers, channel, base }: { blockers: StartBlocker[]; channel: "email" | "linkedin"; base: string }) {
  if (blockers.length === 0) return null;
  return (
    <div id={START_BLOCKERS_ID} role="status" className="stack-field text-sm">
      <p className="font-medium">Start is off until setup is finished</p>
      <ul className="grid gap-0.5 text-muted-foreground">
        {blockers.map((b) => {
          const tab = blockerTab(b.code);
          return (
            <li key={b.code}>
              {b.message}{" "}
              {tab ? (
                <Link href={campaignTabHref(base, tab)} className="text-foreground underline underline-offset-4">
                  Open {CAMPAIGN_TAB_LABELS[tab]}
                </Link>
              ) : (
                <Link href={channel === "linkedin" ? "/settings/linkedin" : "/settings/mailboxes"} className="text-foreground underline underline-offset-4">
                  {channel === "linkedin" ? "Connect an account" : "Connect a mailbox"}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
