import Link from "next/link";
import type { CrossCampaignNotices } from "@/contexts/outreach/application/cross-campaign-notices";
import { noticesSummary } from "@/contexts/outreach/domain/cross-campaign-notice";

const SHOWN = 10;

type Notices = Pick<CrossCampaignNotices, "alreadyContacted" | "alreadyContactedPeople" | "excludedByAccount" | "excludedByAccountPeople">;

/** Names the people in a report who are also in other campaigns, and the leads the sending account's rule skipped. Renders nothing without notices. */
export function CrossCampaignNoticeList({ notices }: { notices: Notices | null | undefined }) {
  if (!notices) return null;
  const summary = noticesSummary(notices);
  if (!summary) return null;
  const contacted = notices.alreadyContacted.slice(0, SHOWN);
  const excluded = notices.excludedByAccount.slice(0, SHOWN);
  const moreContacted = notices.alreadyContacted.length - contacted.length;
  const moreExcluded = notices.excludedByAccount.length - excluded.length;
  return (
    <div className="grid gap-2 text-sm" role="status" data-testid="cross-campaign-notices">
      <p>{summary}</p>
      {contacted.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground">
          {contacted.map((n) => (
            <li key={`${n.personId}:${n.campaign.id}`}>
              <Link href={`/leads/${n.personId}`} className="underline-offset-4 hover:underline">
                {n.name ?? "Unnamed lead"}
              </Link>
              : in{" "}
              <Link href={`/campaigns/${n.campaign.id}`} className="underline-offset-4 hover:underline">
                {n.campaign.name}
              </Link>{" "}
              ({n.status.replace("_", " ")}, {n.channel === "linkedin" ? "LinkedIn" : "email"})
            </li>
          ))}
          {(moreContacted > 0 || notices.alreadyContactedPeople > notices.alreadyContacted.length) && <li>and more. Open the lead to see all its campaigns.</li>}
        </ul>
      )}
      {excluded.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground">
          {excluded.map((n) => (
            <li key={n.enrollmentId}>
              <Link href={`/leads/${n.personId}`} className="underline-offset-4 hover:underline">
                {n.name ?? "Unnamed lead"}
              </Link>
              : skipped, {n.accountName ?? "the sending account"} already invited them
              {n.campaign ? (
                <>
                  {" "}
                  in{" "}
                  <Link href={`/campaigns/${n.campaign.id}`} className="underline-offset-4 hover:underline">
                    {n.campaign.name}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
          {(moreExcluded > 0 || notices.excludedByAccountPeople > notices.excludedByAccount.length) && <li>and more.</li>}
        </ul>
      )}
    </div>
  );
}
