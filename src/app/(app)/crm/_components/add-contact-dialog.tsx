"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { PERSONAL_CAMPAIGN_MESSAGE } from "@/contexts/people/application/conversion-terms";
import { apiMessage, callApi } from "@/app/_lib/api-client";
import { CompanyDomainField, CompanyJoinLine, companyName, useCompanyDomainLookup } from "@/app/(app)/_components/person/company-domain-field";
import { defaultTitle, newIdempotencyKey, permanenceText, singleEffectsText, type ConvertPreview } from "./deal-effects";
import { DealFields, useDealStages } from "./deal-fields";
import { dealFieldsReady, dealRequestFields, firstOpenChoice, initialDealFields, type DealFieldValues, type DealMemberOption, type DealStageList } from "./deal-form";
import { contactLabel } from "./labels";

/**
 * Add contact: a person who starts as a contact, with a deal when "Also create a deal" is checked. One idempotency key
 * per dialog open, so a retry after a lost response does not add the person twice. A matching lead turns the body into the lead
 * step (make that lead a contact, or create its deal); a matching contact links to it and holds the confirm until a field changes.
 */

interface ContactFields {
  firstName: string;
  lastName: string;
  email: string;
  linkedinUrl: string;
  title: string;
  companyDomain: string;
  companyName: string;
}

const EMPTY: ContactFields = { firstName: "", lastName: "", email: "", linkedinUrl: "", title: "", companyDomain: "", companyName: "" };

/** A second person that the typed LinkedIn profile matches (`others` of a 409). */
interface OtherMatch {
  personId: string;
  name: string | null;
  lifecycle: string;
  linkedinUrl: string | null;
}

/** The person a 409 `lead_exists` or `contact_exists` names. */
interface Match {
  personId: string;
  name: string | null;
  email: string | null;
  others: OtherMatch[];
}

export interface AddContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner choices for the deal, from the organization's members. */
  members: DealMemberOption[];
  currentUserId: string;
  /** The pipeline's stages. Left out, the dialog loads them when the deal fields first show. */
  stages?: DealStageList;
  /** Fills Website or domain on open, as the company page does for its own company. */
  initialDomain?: string;
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const blankToNull = (text: string) => text.trim() || null;

function readMatch(details: Record<string, unknown> | null): Match | null {
  if (!details || typeof details.personId !== "string") return null;
  const others = Array.isArray(details.others) ? (details.others as OtherMatch[]).filter((o) => typeof o?.personId === "string") : [];
  return {
    personId: details.personId,
    name: typeof details.name === "string" ? details.name : null,
    email: typeof details.email === "string" ? details.email : null,
    others,
  };
}

/** `{Name}` of the person a 409 names. */
const matchLabel = (match: Match) => contactLabel({ fullName: match.name, email: match.email });

/** "Ada Lovelace (ada@acme.com)", or the one part that exists. */
function matchWithEmail(match: Match): string {
  const name = matchLabel(match);
  return match.name?.trim() && match.email ? `${name} (${match.email})` : upperFirst(name);
}

/** "{Other} ({email or LinkedIn}) matches the LinkedIn profile you typed." `name` already falls back to the email. */
function OtherLines({ others }: { others: OtherMatch[] }) {
  if (others.length === 0) return null;
  return (
    <>
      {others.map((other) => {
        const name = other.name?.trim();
        const who = name && other.linkedinUrl ? `${name} (${other.linkedinUrl})` : (name || other.linkedinUrl);
        if (!who) return null;
        return (
          <p key={other.personId} className="text-sm">
            {who} matches the LinkedIn profile you typed.
          </p>
        );
      })}
    </>
  );
}

export function AddContactDialog({ open, onOpenChange, members, currentUserId, stages: givenStages, initialDomain = "" }: AddContactDialogProps) {
  const router = useRouter();
  const id = useId();
  const [fields, setFields] = useState<ContactFields>({ ...EMPTY, companyDomain: initialDomain });
  const [withDeal, setWithDeal] = useState(false);
  const [deal, setDeal] = useState<DealFieldValues>(() => initialDealFields("", currentUserId));
  const [titleTouched, setTitleTouched] = useState(false);
  /** The lead step: a lead holds the typed email or LinkedIn profile. */
  const [lead, setLead] = useState<Match | null>(null);
  const [preview, setPreview] = useState<ConvertPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** A contact holds the typed email or LinkedIn profile; `typed` is the form as it was sent. */
  const [contact, setContact] = useState<{ match: Match; typed: string } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const [key, setKey] = useState(newIdempotencyKey);
  const lookup = useCompanyDomainLookup(fields.companyDomain);
  const { stages, error: stagesError } = useDealStages(open && withDeal, givenStages);

  // Each open starts from a clean form and a new key.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFields({ ...EMPTY, companyDomain: initialDomain });
      setWithDeal(false);
      setDeal(initialDealFields("", currentUserId));
      setTitleTouched(false);
      setLead(null);
      setPreview(null);
      setPreviewError(null);
      setContact(null);
      setKey(newIdempotencyKey());
    }
  }

  // The lead step states what the conversion stops, from the same preview the Create deal dialog reads.
  const leadId = lead?.personId ?? null;
  useEffect(() => {
    if (!leadId) return;
    let live = true;
    void callApi<ConvertPreview>("/api/leads/convert/preview", "POST", { ids: [leadId] }).then((result) => {
      if (!live) return;
      if (result.ok && result.data) setPreview(result.data);
      else setPreviewError(result.error ?? "Could not check what this changes. Try again.");
    });
    return () => {
      live = false;
    };
  }, [leadId]);

  const typedName = [fields.firstName, fields.lastName].map((part) => part.trim()).filter(Boolean).join(" ");
  const name = contactLabel({ fullName: typedName, email: fields.email });
  const found = lookup.status === "found" ? lookup.company : null;
  /** The name field shows for a domain no company holds, and when the lookup failed (the server checks again). */
  const namesNewCompany = lookup.status === "new" || lookup.status === "unavailable";
  const dealCompany = found ? companyName(found) : namesNewCompany ? blankToNull(fields.companyName) : null;
  const shownTitle = titleTouched ? deal.title : defaultTitle(typedName || blankToNull(fields.email), dealCompany).slice(0, 200);
  const dealForm: DealFieldValues = { ...deal, title: shownTitle, stage: deal.stage ?? firstOpenChoice(stages) };
  const typed = JSON.stringify(fields);
  const set = (field: keyof ContactFields) => (value: string) => setFields((f) => ({ ...f, [field]: value }));

  function changeDeal(next: DealFieldValues) {
    if (next.title !== shownTitle) setTitleTouched(true);
    setDeal(next);
  }

  /** The deal fields of a request. An untouched title goes as null, so the server titles the deal from the saved person. */
  function dealBody() {
    const body = dealRequestFields(dealForm, true);
    return titleTouched ? body : { ...body, title: null };
  }

  async function add(): Promise<boolean> {
    const body = {
      firstName: blankToNull(fields.firstName),
      lastName: blankToNull(fields.lastName),
      email: blankToNull(fields.email),
      linkedinUrl: blankToNull(fields.linkedinUrl),
      title: blankToNull(fields.title),
      companyDomain: blankToNull(fields.companyDomain),
      // A company that exists keeps its name, so the form sends a name only for a new domain.
      companyName: namesNewCompany ? blankToNull(fields.companyName) : null,
      deal: withDeal ? dealBody() : null,
      idempotencyKey: key,
    };
    const result = await callApi<{ personId: string; dealId?: string }>("/api/contacts", "POST", body);
    if (result.ok && result.data) {
      const { personId, dealId } = result.data;
      toast.success(dealId ? `Added ${name} with a deal.` : `Added ${name}.`);
      router.push(dealId ? `/crm/deals/${dealId}` : `/crm/contacts/${personId}`);
      return true;
    }
    const code = result.code;
    const match = readMatch(result.details);
    if (code === "lead_exists" && match) {
      setPreview(null);
      setPreviewError(null);
      setLead(match);
      return false;
    }
    if (code === "contact_exists" && match) {
      setContact({ match, typed });
      return false;
    }
    if (code === "try_again") throw new Error(apiMessage("try_again", name));
    throw new Error(result.error ?? "Could not add the contact. Try again.");
  }

  /** The lead step: Make contact, or Create deal with the box checked. Both keep the lead's saved details. */
  async function convertLead(match: Match): Promise<boolean> {
    const label = matchLabel(match);
    const done = (path: string) => {
      toast.success(`${upperFirst(label)} is a contact now.`);
      router.push(path);
      return true;
    };
    if (withDeal) {
      const result = await callApi<{ dealId: string }>(`/api/leads/${match.personId}/convert`, "POST", { ...dealBody(), idempotencyKey: key });
      if (result.ok && result.data) return done(`/crm/deals/${result.data.dealId}`);
      if (result.code === "already_converted") throw new Error(`${upperFirst(label)} is already a contact.`);
      if (result.code === "try_again") throw new Error(apiMessage("try_again", label));
      throw new Error(result.error ?? "Could not create the deal. Try again.");
    }
    const result = await callApi<{ personId: string }>(`/api/leads/${match.personId}/make-contact`, "POST", {});
    // `already_converted` means someone else made the lead a contact first: the outcome stands, so open the contact.
    if (result.ok || result.code === "already_converted") return done(`/crm/contacts/${match.personId}`);
    if (result.code === "try_again") throw new Error(apiMessage("try_again", label));
    if (result.code === "personal_campaign") throw new Error(PERSONAL_CAMPAIGN_MESSAGE);
    // A 404 answers "Lead not found"; the dialog names the person instead.
    if (result.code === "not_found") throw new Error(`${upperFirst(label)} no longer exists.`);
    throw new Error(result.error ?? "Could not make the lead a contact. Try again.");
  }

  const dealReady = !withDeal || dealFieldsReady(dealForm, stages, true);

  if (lead) {
    const label = matchLabel(lead);
    const held = preview !== null && preview.skippedPersonalCampaign > 0;
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Add contact"
        description={`${matchWithEmail(lead)} is already a lead.`}
        confirmLabel={withDeal ? "Create deal" : `Make ${label} a contact`}
        pendingLabel={withDeal ? "Creating…" : "Making contact…"}
        confirmDisabled={preview === null || held || !dealReady}
        className="sm:max-w-lg"
        back={{ label: "Back", onClick: () => setLead(null) }}
        onConfirm={() => convertLead(lead)}
      >
        <div className="stack-group text-sm" data-testid="add-contact-lead">
          {held ? (
            <p role="status">{PERSONAL_CAMPAIGN_MESSAGE}</p>
          ) : (
            <p className="text-muted-foreground" aria-busy={preview === null && !previewError}>
              {previewError ?? (preview ? singleEffectsText(label, preview) : "Checking what this changes…")}
            </p>
          )}
          <p>{permanenceText(upperFirst(label), { withDeal })}</p>
          <p>MiaSDR keeps {label}&apos;s saved details and drops what you typed here. Edit them on the contact page.</p>
          <OtherLines others={lead.others} />
          <div>
            <Link href={`/leads/${lead.personId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Open lead
            </Link>
          </div>
        </div>
      </ConfirmDialog>
    );
  }

  const unchangedContact = contact !== null && contact.typed === typed;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add contact"
      description=""
      confirmLabel={withDeal ? "Add contact and deal" : "Add contact"}
      pendingLabel="Adding…"
      confirmDisabled={lookup.status === "checking" || lookup.status === "invalid" || !dealReady || unchangedContact}
      className="sm:max-w-lg [&_[data-slot=dialog-description]:empty]:hidden"
      onConfirm={add}
    >
      <form
        className="stack-section"
        data-testid="add-contact-form"
        onSubmit={(e) => {
          // Enter in a field does not submit: the footer's button does, so the dialog keeps its pending state.
          e.preventDefault();
        }}
      >
        {contact && (
          <div role="status" className="stack-group text-sm">
            <p>{matchWithEmail(contact.match)} is already a contact.</p>
            <OtherLines others={contact.match.others} />
            <div>
              <Link href={`/crm/contacts/${contact.match.personId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Open contact
              </Link>
            </div>
          </div>
        )}
        <div className="stack-group">
          <div className="grid gap-group sm:grid-cols-2">
            <TextField id={`${id}-first`} label="First name" value={fields.firstName} onChange={set("firstName")} autoFocus />
            <TextField id={`${id}-last`} label="Last name" value={fields.lastName} onChange={set("lastName")} />
          </div>
          <TextField id={`${id}-email`} label="Email" value={fields.email} onChange={set("email")} inputMode="email" />
          <TextField id={`${id}-linkedin`} label="LinkedIn profile" value={fields.linkedinUrl} onChange={set("linkedinUrl")} inputMode="url" placeholder="https://www.linkedin.com/in/name" />
          <TextField id={`${id}-title`} label="Job title" value={fields.title} onChange={set("title")} />
          <CompanyDomainField id={`${id}-domain`} value={fields.companyDomain} onChange={set("companyDomain")} lookup={lookup} />
          {found && <CompanyJoinLine company={found} typedName={fields.companyName} />}
          {namesNewCompany && <TextField id={`${id}-company`} label="Company name" value={fields.companyName} onChange={set("companyName")} placeholder={fields.companyDomain.trim()} />}
          <p className="text-xs text-muted-foreground">Add a phone number and custom fields on the contact page.</p>
        </div>
        <div className="stack-group">
          <Field orientation="horizontal">
            <Checkbox id={`${id}-deal`} checked={withDeal} onCheckedChange={(checked) => setWithDeal(checked === true)} />
            <FieldLabel htmlFor={`${id}-deal`}>Also create a deal</FieldLabel>
          </Field>
          {withDeal && stagesError && (
            <p role="alert" className="text-sm text-destructive">
              {stagesError}
            </p>
          )}
          {withDeal && <DealFields idPrefix={`${id}-deal`} values={dealForm} onChange={changeDeal} stages={stages} members={members} currentUserId={currentUserId} full />}
        </div>
      </form>
    </ConfirmDialog>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "email" | "url";
  autoFocus?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} value={value} placeholder={placeholder} inputMode={inputMode} autoComplete="off" autoFocus={autoFocus} touch onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** An Add contact button with its dialog. */
export function AddContactButton({
  label = "Add contact",
  variant = "default",
  className,
  ...props
}: Omit<AddContactDialogProps, "open" | "onOpenChange"> & { label?: string; variant?: "default" | "outline"; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AddContactDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
