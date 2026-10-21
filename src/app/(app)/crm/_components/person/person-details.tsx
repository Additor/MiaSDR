"use client";

import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { CompanyDomainField, CompanyJoinLine, companyName, useCompanyDomainLookup } from "../company-domain-field";
import { EditableFact, InlineForm, NotSet, type EditorProps, type SaveResult } from "../record/inline-field";
import { AsideSection } from "../record/record-header";
import type { CustomField, LeadFormValues } from "./person-fields";

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
 * A person's facts, each one edited and saved on its own row. Empty contact points stay listed as "Not set", so the panel
 * shows what is missing. Facts the person cannot change (when they were added, from where, when they became a contact)
 * close the panel as one muted line.
 */
export function PersonDetails({
  id,
  noun,
  values,
  customFields,
  facts,
  dealCount = 0,
}: {
  id: string;
  noun: "lead" | "contact";
  values: LeadFormValues;
  customFields: CustomField[];
  facts: PersonFacts;
  /** A contact's deals, for the company move and remove confirm. */
  dealCount?: number;
}) {
  const person = values.fullName.trim() || [values.firstName, values.lastName].filter((v) => v.trim()).join(" ") || values.email.trim() || `this ${noun}`;
  const save = (body: Record<string, unknown>) => savePerson(id, body, person);
  const filled = customFields.filter((c) => c.value.trim() !== "");
  const name = values.fullName || [values.firstName, values.lastName].filter(Boolean).join(" ");

  return (
    <AsideSection title="Details" testId="person-details">
      <dl className="stack-group text-sm">
        <EditableFact
          label="Name"
          saved="Name saved."
          inputs={[
            { key: "firstName", label: "First name", value: values.firstName },
            { key: "lastName", label: "Last name", value: values.lastName },
            { key: "fullName", label: "Full name", value: values.fullName, help: "Left empty, the first and last name make it." },
          ]}
          onSave={save}
        >
          {name || <NotSet />}
        </EditableFact>
        <EditableFact label="Job title" saved="Job title saved." inputs={[{ key: "title", value: values.title }]} onSave={save}>
          {values.title || <NotSet />}
        </EditableFact>
        <EditableFact label="Email" saved="Email saved." inputs={[{ key: "email", value: values.email, inputMode: "email", help: `A ${noun} needs an email or a LinkedIn profile.` }]} onSave={save}>
          {values.email ? <ValueLink href={facts.emailHref}>{values.email}</ValueLink> : <NotSet />}
        </EditableFact>
        <EditableFact label="Phone" saved="Phone saved." inputs={[{ key: "phone", value: values.phone, type: "tel", inputMode: "tel", placeholder: "+1 555 0100" }]} onSave={save}>
          {values.phone ? <ValueLink href={facts.phoneHref}>{values.phone}</ValueLink> : <NotSet />}
        </EditableFact>
        <EditableFact label="LinkedIn" saved="LinkedIn saved." inputs={[{ key: "linkedin", value: values.linkedin, inputMode: "url", placeholder: "https://www.linkedin.com/in/name" }]} onSave={save}>
          {facts.linkedinHref ? (
            <ValueLink href={facts.linkedinHref} external="LinkedIn profile (opens in a new tab)">
              Profile
            </ValueLink>
          ) : (
            <NotSet />
          )}
        </EditableFact>
        <EditableFact label="Company" saved="Company saved." testId="person-company" editor={(props) => <CompanyEditor {...props} id={id} person={person} values={values} companyHref={facts.companyHref} dealCount={dealCount} />}>
          <CompanyValue values={values} href={facts.companyHref} />
        </EditableFact>
        {filled.map((c) => (
          <EditableFact key={c.key} label={c.name} saved={`${c.name} saved.`} inputs={[{ key: c.key, value: c.value, help: "Empty removes the value." }]} onSave={(v) => save({ custom: { [c.key]: v[c.key] } })}>
            {c.value}
          </EditableFact>
        ))}
      </dl>
      <AddField
        fields={customFields}
        allowNew
        onSave={(field, value) => save(field.key ? { custom: { [field.key]: value } } : { newCustom: [{ label: field.name, value }] })}
      />
      <PersonOrigin facts={facts} />
    </AsideSection>
  );
}

/** PATCH one change to the person. Leaves every field the body does not name as it is. */
async function savePerson(id: string, body: Record<string, unknown>, person: string): Promise<SaveResult> {
  const result = await callApi(`/api/leads/${id}`, "PATCH", body);
  if (result.ok) return null;
  if (result.details?.code === "try_again") return `MiaSDR is saving another change to ${person}. Try again in a moment.`;
  return result.issues[0]?.message ?? result.error ?? "Could not save.";
}

function CompanyValue({ values, href }: { values: LeadFormValues; href: string | null }) {
  const company = values.companyName || values.companyDomain;
  if (!company) return <NotSet />;
  return (
    <>
      {href ? (
        <Link href={href} className="underline-offset-4 hover:underline">
          {company}
        </Link>
      ) : (
        company
      )}
      {values.companyName && values.companyDomain && <span className="block text-muted-foreground">{values.companyDomain}</span>}
    </>
  );
}

/** Where the person came from and when, in one line: nothing here is editable. */
function PersonOrigin({ facts }: { facts: PersonFacts }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="person-origin">
      {facts.contactSince && (
        <>
          Contact since <Time value={facts.contactSince} dateOnly />
          {facts.sourceCampaign && (
            <>
              {" from "}
              <Link href={facts.sourceCampaign.href} className="underline underline-offset-4 hover:text-foreground" data-testid="contact-source">
                {facts.sourceCampaign.name}
              </Link>
            </>
          )}
          {". "}
        </>
      )}
      Added <Time value={facts.created} />
      {facts.source ? ` (${facts.source.toLowerCase()})` : ""}. Changed <Time value={facts.updated} />.
    </p>
  );
}

/** A save that changes the company of a person who has one asks first. */
type CompanyChange = { kind: "move"; to: string } | { kind: "remove" };

/**
 * The company row's editor. It never renames a company: a known domain joins its company, a new domain asks for a name,
 * and moving or removing a person who has a company asks first.
 */
function CompanyEditor({ id, person, values, companyHref, dealCount, close }: EditorProps & { id: string; person: string; values: LeadFormValues; companyHref: string | null; dealCount: number }) {
  const base = useId();
  const had = values.companyDomain.trim() !== "";
  const oldCompany = values.companyName.trim() || values.companyDomain;
  const [domain, setDomain] = useState(values.companyDomain);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<CompanyChange | null>(null);
  const typed = domain.trim();
  const same = had && typed.toLowerCase() === values.companyDomain.toLowerCase();
  const lookup = useCompanyDomainLookup(same ? "" : typed);
  const errorId = `${base}-error`;

  async function save(remove: boolean) {
    setPending(true);
    setError(null);
    // An existing company keeps its name, so the editor sends a name only for a domain no company holds yet.
    const body = remove ? { companyDomain: "" } : { companyDomain: typed, companyName: lookup.status === "found" ? "" : name };
    const problem = await savePerson(id, body, person);
    setPending(false);
    if (problem) {
      setError(problem);
      throw new Error(problem);
    }
    close(true);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (same || (!had && typed === "")) return close(false);
    if (!had) return void save(false).catch(() => undefined);
    if (typed === "") return setAsking({ kind: "remove" });
    setAsking({ kind: "move", to: lookup.status === "found" ? companyName(lookup.company) : typed });
  }

  const asked = asking ?? { kind: "remove" as const };
  const dealsLine = dealCount > 0 ? (asked.kind === "move" ? " Their deals move with them." : " Their deals stay with them.") : "";

  return (
    <InlineForm
      label="Company"
      onSubmit={onSubmit}
      onCancel={() => close(false)}
      busy={pending || lookup.status === "checking"}
      error={error}
      errorId={errorId}
      extra={
        had && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} className="max-sm:h-11" onClick={() => setAsking({ kind: "remove" })}>
            Remove company
          </Button>
        )
      }
    >
      <div className="grid gap-group text-sm" data-testid="person-company-editor">
        {had && (
          <p className="text-xs text-muted-foreground">
            Now at{" "}
            {companyHref ? (
              <Link href={companyHref} className="underline underline-offset-4 hover:text-foreground">
                {oldCompany}
              </Link>
            ) : (
              oldCompany
            )}
            . Rename the company on its page.
          </p>
        )}
        <CompanyDomainField id={`${base}-domain`} value={domain} onChange={setDomain} lookup={lookup} autoFocus />
        {!same && typed !== "" && lookup.status === "found" && <CompanyJoinLine company={lookup.company} typedName={name} />}
        {!same && typed !== "" && lookup.status !== "found" && (
          <div className="stack-field">
            <Label htmlFor={`${base}-name`}>Company name</Label>
            <Input id={`${base}-name`} value={name} autoComplete="off" aria-describedby={`${base}-name-help`} className="max-sm:h-11" onChange={(e) => setName(e.target.value)} />
            <p id={`${base}-name-help`} className="text-xs text-muted-foreground">
              Names the company when the domain is new.
            </p>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={asked.kind === "move" ? `Move ${person} to ${asked.to}?` : `Remove ${person} from ${oldCompany}?`}
        description={`${person} leaves ${oldCompany}.${dealsLine}`}
        confirmLabel={asked.kind === "move" ? "Move" : "Remove"}
        cancelLabel={`Keep ${oldCompany}`}
        onConfirm={() => save(asked.kind === "remove")}
      />
    </InlineForm>
  );
}

export interface FieldChoice {
  /** The field's key, or "" for a field the save creates. */
  key: string;
  name: string;
}

/**
 * Adds a value to a field that has none: one of the fields without a value, or with `allowNew` a field the save creates.
 * The fields with a value already have their own rows.
 */
export function AddField({ fields, allowNew = false, onSave, settingsHint }: { fields: CustomField[]; allowNew?: boolean; onSave: (field: FieldChoice, value: string) => Promise<SaveResult>; settingsHint?: ReactNode }) {
  const base = useId();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = fields.filter((c) => c.value.trim() === "");
  const fold = (s: string) => s.trim().toLowerCase();

  if (!allowNew && empty.length === 0) return settingsHint ?? null;

  function reset() {
    setOpen(false);
    setField("");
    setValue("");
    setError(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const typed = field.trim();
    if (!typed) return setError("Name the field.");
    if (!value.trim()) return setError("Type a value for the field.");
    const known = fields.find((c) => fold(c.name) === fold(typed) || c.key === typed);
    if (known && known.value.trim() !== "") return setError(`${known.name} has a value. Edit it on its row.`);
    if (!known && !allowNew) return setError("Pick one of the company fields. Settings, Custom fields adds new ones.");
    setPending(true);
    setError(null);
    const problem = await onSave(known ? { key: known.key, name: known.name } : { key: "", name: typed }, value);
    setPending(false);
    if (problem) return setError(problem);
    toast.success(`${known?.name ?? typed} saved.`);
    // The refreshed page brings the field's own row; the form stays until it arrives.
    startRefresh(() => {
      router.refresh();
      reset();
    });
  }

  if (!open) {
    return (
      <div>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground max-sm:h-11" onClick={() => setOpen(true)}>
          <PlusIcon /> Add field
        </Button>
      </div>
    );
  }

  return (
    <InlineForm label={null} onSubmit={onSubmit} onCancel={reset} busy={pending || refreshing} error={error} errorId={`${base}-error`} submitLabel="Add">
      <div className="stack-field">
        <Label htmlFor={`${base}-field`}>Field</Label>
        <Input
          id={`${base}-field`}
          autoFocus
          list={`${base}-fields`}
          value={field}
          autoComplete="off"
          placeholder={allowNew ? "Pick a field or name a new one" : "Pick a field"}
          className="max-sm:h-11"
          onChange={(e) => setField(e.target.value)}
        />
        <datalist id={`${base}-fields`}>
          {empty.map((c) => (
            <option key={c.key} value={c.name} />
          ))}
        </datalist>
      </div>
      <div className="stack-field">
        <Label htmlFor={`${base}-value`}>Value</Label>
        <Input id={`${base}-value`} value={value} autoComplete="off" className="max-sm:h-11" onChange={(e) => setValue(e.target.value)} />
      </div>
    </InlineForm>
  );
}

/** `external` is the accessible name of a link that opens in a new tab. */
function ValueLink({ href, external, children }: { href: string | null; external?: string; children: ReactNode }) {
  if (!href) return <span className="break-words">{children}</span>;
  return (
    <a href={href} className="[overflow-wrap:anywhere] underline-offset-4 hover:underline" {...(external ? { target: "_blank", rel: "noopener noreferrer", "aria-label": external } : {})}>
      {children}
    </a>
  );
}
