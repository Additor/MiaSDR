import { BanIcon, MailIcon, MailXIcon } from "lucide-react";
import { Time } from "@/components/shell/time";
import type { LeadContactPoints } from "@/contexts/people/domain/lead-activity";
import { suppressionReasonLabel, type Reachability } from "@/contexts/people/domain/reachability";
import { cn } from "@/components/ui/utils";
import { StateTip, TipLines } from "./state-tip";

/** "Do not contact", the reason and since when, for a tooltip. */
export function DoNotContactTip({ dnc }: { dnc: NonNullable<Reachability["doNotContact"]> }) {
  return (
    <TipLines
      lines={[
        <span key="title" className="font-medium">
          Do not contact
        </span>,
        dnc.reason,
        dnc.since && (
          <>
            Since <Time value={dnc.since} dateOnly />
          </>
        ),
      ]}
    />
  );
}

/** "Email suppressed: Bounced, since 2026-10-01". Suppression blocks email only. */
export function SuppressedTip({ email }: { email: Reachability["email"] }) {
  return (
    <>
      {`Email suppressed${email.suppressionReason ? `: ${suppressionReasonLabel(email.suppressionReason)}` : ""}`}
      {email.since && (
        <>
          , since <Time value={email.since} dateOnly />
        </>
      )}
    </>
  );
}

const iconClasses = "inline-flex size-7 items-center justify-center rounded-md border [&_svg]:size-4";
const liveClasses = "relative z-10 bg-background hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";

/**
 * A person's reach in a list row: a do-not-contact mark when it applies, then Email and LinkedIn as icon buttons. An open
 * channel is a link that sits above the row's stretched link (`relative z-10`): `mailto:` for the address, the profile in
 * a new tab. A suppressed address shows a crossed mail icon with the reason on hover and focus. A missing value is a
 * dashed, crossed-out mark that is not interactive. Each state carries its name for screen readers, so none rests on color.
 */
export function ReachIcons({ reach, contact, person }: { reach: Reachability; contact: LeadContactPoints; person: string }) {
  const blocked = reach.doNotContact !== null;
  const tone = blocked ? "text-muted-foreground" : "text-foreground";
  const email = reach.email.state === "missing" ? null : contact.email;
  const linkedin = reach.linkedin.state === "missing" ? null : contact.linkedin;
  return (
    <span className="inline-flex items-center gap-1" data-testid="reach-icons">
      {reach.doNotContact && (
        <StateTip
          trigger={<span tabIndex={0} className={cn(iconClasses, liveClasses, "border-transparent text-muted-foreground")} data-testid="reach-dnc" />}
          tip={<DoNotContactTip dnc={reach.doNotContact} />}
        >
          <BanIcon aria-hidden />
        </StateTip>
      )}
      {email && reach.email.state === "suppressed" ? (
        <StateTip
          trigger={<a href={email.href} className={cn(iconClasses, liveClasses, "text-muted-foreground")} data-testid="reach-email-suppressed" />}
          tip={<SuppressedTip email={reach.email} />}
        >
          <MailXIcon aria-hidden />
          <span className="sr-only">{`Email ${email.address}`}</span>
        </StateTip>
      ) : email ? (
        <a href={email.href} aria-label={`Email ${email.address}`} title={`Email ${email.address}`} className={cn(iconClasses, liveClasses, tone)}>
          <MailIcon aria-hidden />
        </a>
      ) : (
        <span role="img" aria-label="No email" title="No email" className={cn(iconClasses, "border-dashed text-muted-foreground")}>
          <MailXIcon aria-hidden />
        </span>
      )}
      {linkedin ? (
        <a
          href={linkedin.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open LinkedIn profile of ${person}`}
          title={`Open LinkedIn profile of ${person}`}
          className={cn(iconClasses, liveClasses, tone)}
        >
          <LinkedInMark />
        </a>
      ) : (
        <span role="img" aria-label="No LinkedIn" title="No LinkedIn" className={cn(iconClasses, "border-dashed text-muted-foreground")}>
          <LinkedInMark crossed />
        </span>
      )}
    </span>
  );
}

/** The "in" mark. lucide ships no brand icons, so the glyph is drawn here; `crossed` adds the strike for a missing profile. */
export function LinkedInMark({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 10v7M7 7v.01M11 17v-7M11 13a3 3 0 0 1 6 0v4" />
      {crossed && <path d="M3 3l18 18" />}
    </svg>
  );
}
