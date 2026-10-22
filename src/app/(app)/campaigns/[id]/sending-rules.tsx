import Link from "next/link";
import { CampaignSection } from "./campaign-section";

/** Settings section: the send rules this campaign follows, read-only. The values live in the organization settings. */
export function SendingRules({ channel, line }: { channel: "email" | "linkedin"; line: string | null }) {
  const linkedin = channel === "linkedin";
  return (
    <CampaignSection title="Sending rules" testId="sending-rules" description="Every campaign of your organization follows the same rules.">
      <div className="stack-field text-sm">
        <p>{line ?? "The limits show here once a LinkedIn account sends for this campaign."}</p>
        <p>
          <Link href={linkedin ? "/settings/linkedin" : "/settings/mailboxes#sending-rules"} className="underline underline-offset-4">
            {linkedin ? "Change LinkedIn settings" : "Change email settings"}
          </Link>
        </p>
      </div>
    </CampaignSection>
  );
}
