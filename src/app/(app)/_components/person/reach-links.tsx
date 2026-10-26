import { BanIcon, ExternalLinkIcon, MailIcon, MailXIcon, PhoneIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { LeadContactPoints } from "@/contexts/people/domain/lead-activity";
import type { Reachability } from "@/contexts/outreach/domain/reachability";
import { cn } from "@/components/ui/utils";
import { DoNotContactTip, SuppressedTip } from "./reach-icons";
import { StateTip } from "./state-tip";

const linkClasses =
  "inline-flex min-h-6 items-center gap-1.5 rounded-sm text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11";
const textClasses = "inline-flex min-h-6 items-center gap-1.5 text-sm";

/**
 * The reach row of a record header: Email, LinkedIn and phone as links, each showing its own state. A person marked do
 * not contact gets a neutral badge in front, with the reason and date on hover and focus, and the links read muted. A
 * suppressed address keeps its link, crossed out, with the reason on hover and focus; LinkedIn stays open. The contact
 * points come from `leadContactPoints`, as in `ReachIcons`, so a missing or unsafe address or profile is left out. A phone
 * that cannot make a safe link prints as plain text.
 */
export function ReachLinks({ reach, contact, phone, phoneHref }: { reach: Reachability; contact: LeadContactPoints; phone: string | null; phoneHref: string | null }) {
  const muted = reach.doNotContact !== null;
  const tone = muted ? "text-muted-foreground" : undefined;
  const items: ReactNode[] = [];
  const { email, linkedin } = contact;
  if (email && reach.email.state === "suppressed") {
    items.push(
      <StateTip key="email" trigger={<a href={email.href} className={cn(linkClasses, "text-muted-foreground")} data-testid="reach-email-suppressed" />} tip={<SuppressedTip email={reach.email} />}>
        <MailXIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="break-all line-through">{email.address}</span>
      </StateTip>,
    );
  } else if (email) {
    items.push(
      <a key="email" href={email.href} className={cn(linkClasses, tone)}>
        <MailIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="break-all">{email.address}</span>
      </a>,
    );
  }
  if (linkedin) {
    items.push(
      <a key="linkedin" href={linkedin.href} target="_blank" rel="noopener noreferrer" className={cn(linkClasses, tone)}>
        LinkedIn profile
        <ExternalLinkIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>,
    );
  }
  if (phone) {
    items.push(
      phoneHref ? (
        <a key="phone" href={phoneHref} className={cn(linkClasses, tone)}>
          <PhoneIcon aria-hidden className="size-4 text-muted-foreground" />
          {phone}
        </a>
      ) : (
        <span key="phone" className={cn(textClasses, tone)}>
          <PhoneIcon aria-hidden className="size-4 text-muted-foreground" />
          {phone}
        </span>
      ),
    );
  }
  const dnc = reach.doNotContact && (
    <StateTip
      key="dnc"
      trigger={<Badge variant="secondary" tabIndex={0} className="h-6 px-2 text-sm" data-testid="reach-dnc" />}
      tip={<DoNotContactTip dnc={reach.doNotContact} />}
    >
      <BanIcon aria-hidden />
      Do not contact
    </StateTip>
  );
  if (items.length === 0 && !dnc) return <p className="text-sm text-muted-foreground">No email, LinkedIn profile or phone yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1" data-testid="reach-links">
      {dnc}
      {items.length > 0 ? items : <span className="text-sm text-muted-foreground">No email, LinkedIn profile or phone yet.</span>}
    </div>
  );
}
