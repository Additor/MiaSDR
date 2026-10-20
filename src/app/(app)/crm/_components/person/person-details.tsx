"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { AsideSection } from "../record/record-header";
import { LeadForm, type CustomField, type LeadFormValues } from "./lead-form";

export interface PersonFacts {
  emailHref: string | null;
  phoneHref: string | null;
  linkedinHref: string | null;
  /** The company page, when the person has a company the CRM shows. */
  companyHref: string | null;
  /** Source label, such as "Import" or "Demo seed". */
  source: string | null;
  /** ISO timestamp of the conversion, for a contact. */
  contactSince?: string | null;
  /** The campaign of the deal that made the person a contact. A personal campaign never shows. */
  sourceCampaign?: { name: string; href: string } | null;
  /** ISO timestamps. */
  created: string;
  updated: string;
}

/**
 * A person's facts, read first: each value is text or a link, and Edit turns the panel into the form. Empty contact
 * points stay listed as "Not set", so the panel shows what is missing.
 */
export function PersonDetails({
  id,
  noun,
  values,
  customFields,
  facts,
  dealCount,
}: {
  id: string;
  noun: "lead" | "contact";
  values: LeadFormValues;
  customFields: CustomField[];
  facts: PersonFacts;
  /** A contact's deals, for the form's move and remove confirm. */
  dealCount?: number;
}) {
  const [editing, setEditing] = useState(false);
  const filled = customFields.filter((c) => c.value.trim() !== "");
  const company = values.companyName || values.companyDomain;

  return (
    <AsideSection
      title="Details"
      testId="person-details"
      action={
        !editing && (
          <Button variant="ghost" size="sm" className="max-sm:h-11" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <LeadForm id={id} noun={noun} initial={values} customFields={customFields} companyHref={facts.companyHref} dealCount={dealCount} onDone={() => setEditing(false)} />
      ) : (
        <dl className="stack-group text-sm">
          <Fact label="Email">{values.email ? <ValueLink href={facts.emailHref}>{values.email}</ValueLink> : <NotSet />}</Fact>
          <Fact label="Phone">{values.phone ? <ValueLink href={facts.phoneHref}>{values.phone}</ValueLink> : <NotSet />}</Fact>
          <Fact label="LinkedIn">
            {facts.linkedinHref ? (
              <ValueLink href={facts.linkedinHref} external="LinkedIn profile (opens in a new tab)">
                Profile
              </ValueLink>
            ) : (
              <NotSet />
            )}
          </Fact>
          {values.title && <Fact label="Job title">{values.title}</Fact>}
          {company && (
            <Fact label="Company">
              {facts.companyHref ? (
                <Link href={facts.companyHref} className="underline-offset-4 hover:underline">
                  {company}
                </Link>
              ) : (
                company
              )}
              {values.companyName && values.companyDomain && <span className="block text-muted-foreground">{values.companyDomain}</span>}
            </Fact>
          )}
          {filled.map((c) => (
            <Fact key={c.key} label={c.name}>
              {c.value}
            </Fact>
          ))}
          {facts.contactSince && (
            <Fact label="Contact since">
              <Time value={facts.contactSince} dateOnly />
            </Fact>
          )}
          {facts.sourceCampaign && (
            <Fact label="Campaign">
              <Link href={facts.sourceCampaign.href} className="underline-offset-4 hover:underline" data-testid="contact-source">
                {facts.sourceCampaign.name}
              </Link>
            </Fact>
          )}
          <Fact label="Added">
            <Time value={facts.created} />
            {facts.source && <span className="text-muted-foreground">{`, ${facts.source.toLowerCase()}`}</span>}
          </Fact>
          <Fact label="Last changed">
            <Time value={facts.updated} />
          </Fact>
        </dl>
      )}
    </AsideSection>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const NotSet = () => <span className="text-muted-foreground">Not set</span>;

/** `external` is the accessible name of a link that opens in a new tab. */
function ValueLink({ href, external, children }: { href: string | null; external?: string; children: ReactNode }) {
  if (!href) return <span className="break-all">{children}</span>;
  return (
    <a
      href={href}
      className="break-all underline-offset-4 hover:underline"
      {...(external ? { target: "_blank", rel: "noopener noreferrer", "aria-label": external } : {})}
    >
      {children}
    </a>
  );
}
