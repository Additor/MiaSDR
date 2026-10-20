"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { CompanyDomainField, CompanyJoinLine, companyName, useCompanyDomainLookup } from "../company-domain-field";

export interface LeadFormValues {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  linkedin: string;
  title: string;
  companyDomain: string;
  companyName: string;
}

export interface CustomField {
  key: string;
  name: string;
  value: string;
}

interface FieldSpec {
  name: keyof LeadFormValues;
  label: string;
  type?: string;
  inputMode?: "email" | "tel" | "url";
  autoComplete?: string;
  placeholder?: string;
  /** A line under the field. It is the field's description for assistive technology. */
  help?: string;
  wide?: boolean;
}

/** Details in groups, so the name trio sits apart from the job title and the contact points. The Company group follows them. */
const GROUPS: Array<{ legend: string; fields: FieldSpec[] }> = [
  {
    legend: "Identity",
    fields: [
      { name: "firstName", label: "First name", autoComplete: "off" },
      { name: "lastName", label: "Last name", autoComplete: "off" },
      { name: "fullName", label: "Full name", autoComplete: "off" },
      { name: "title", label: "Job title", autoComplete: "off" },
    ],
  },
  {
    legend: "Contact",
    fields: [
      { name: "email", label: "Email", inputMode: "email", autoComplete: "off" },
      { name: "phone", label: "Phone", type: "tel", inputMode: "tel", placeholder: "+1 555 0100", autoComplete: "off" },
      { name: "linkedin", label: "LinkedIn profile", inputMode: "url", placeholder: "https://www.linkedin.com/in/name", autoComplete: "off", wide: true },
    ],
  },
];

/** A save that changes the company of a person who has one asks first. */
type CompanyChange = { kind: "move"; to: string } | { kind: "remove" };

/**
 * The edit form of a person's Details panel. It sits inside the panel's card, so it brings no card of its own, and it
 * lays its fields out in two columns only when its container is wide enough.
 *
 * The Company group never edits an existing company. A person with a company sees it as a read-only link with
 * Change company and Remove company; a new domain asks for the company name, a known one reads "Joins {Company} ({domain})."
 * and the form sends no name for it. Saving a move or a removal asks first.
 */
export function LeadForm({
  id,
  initial,
  customFields,
  noun = "lead",
  companyHref = null,
  dealCount = 0,
  onDone,
}: {
  id: string;
  initial: LeadFormValues;
  customFields: CustomField[];
  /** The word for the person in the form's text: the contact page passes "contact". */
  noun?: "lead" | "contact";
  /** The page of the person's company, when the caller knows it. Left out, the form looks the stored domain up. */
  companyHref?: string | null;
  /** The contact's deals, for the move and remove lines "Their deals move with them." and "Their deals stay with them." */
  dealCount?: number;
  /** Called after a save and on Cancel. */
  onDone: () => void;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<LeadFormValues>(initial);
  const [custom, setCustom] = useState<Record<string, string>>(Object.fromEntries(customFields.map((c) => [c.key, c.value])));
  const [added, setAdded] = useState<Array<{ label: string; value: string }>>([]);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const hadCompany = initial.companyDomain.trim() !== "";
  // A person without a company starts on the domain field; one with a company starts on its read-only row.
  const [changing, setChanging] = useState(!hadCompany);
  const [asking, setAsking] = useState<CompanyChange | null>(null);
  const decided = useRef(false);
  const lookup = useCompanyDomainLookup(changing ? fields.companyDomain : "");
  // The stored company's page, when the caller did not pass it: the same lookup over the stored domain.
  const stored = useCompanyDomainLookup(hadCompany && !companyHref ? initial.companyDomain : "");
  const storedHref = companyHref ?? (stored.status === "found" ? `/crm/companies/${stored.company.companyId}` : null);
  const storedId = stored.status === "found" ? stored.company.companyId : companyHref?.split("/").pop();

  const person = initial.fullName.trim() || [initial.firstName, initial.lastName].filter((v) => v.trim()).join(" ") || initial.email.trim() || `this ${noun}`;
  const oldCompany = initial.companyName.trim() || initial.companyDomain;

  /** What a save does to the company: nothing, a move to another company, or a removal. */
  function companyChange(): CompanyChange | null {
    if (!hadCompany || !changing) return null;
    const typed = fields.companyDomain.trim();
    if (typed === "") return { kind: "remove" };
    if (typed.toLowerCase() === initial.companyDomain.toLowerCase()) return null;
    if (lookup.status === "found") {
      if (lookup.company.companyId === storedId) return null;
      return { kind: "move", to: companyName(lookup.company) };
    }
    return { kind: "move", to: typed };
  }

  /** `keepCompany` leaves the company as it was and saves the other edits ("Keep {old company}"). */
  async function save(keepCompany: boolean) {
    setPending(true);
    setErrors([]);
    const { companyDomain, companyName: typedName, ...rest } = fields;
    // An existing company keeps its name, so the form sends a name only for a domain no company holds yet.
    const company = keepCompany || !changing ? {} : { companyDomain, companyName: lookup.status === "found" ? "" : typedName };
    const result = await callApi(`/api/leads/${id}`, "PATCH", { ...rest, ...company, custom, newCustom: added.filter((a) => a.label.trim() !== "") });
    setPending(false);
    if (!result.ok) {
      if (result.details?.code === "try_again") setErrors([`MiaSDR is saving another change to ${person}. Try again in a moment.`]);
      else setErrors(result.issues.length > 0 ? result.issues.map((i) => i.message) : [result.error ?? "Could not save."]);
      return;
    }
    toast.success(noun === "contact" ? "Contact saved." : "Lead saved.");
    setAdded([]);
    onDone();
    router.refresh();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const change = companyChange();
    if (change) {
      decided.current = false;
      setAsking(change);
      return;
    }
    void save(false);
  }

  function keepOldCompany() {
    setFields((f) => ({ ...f, companyDomain: initial.companyDomain, companyName: initial.companyName }));
    setChanging(false);
    void save(true);
  }

  const asked = asking ?? { kind: "remove" as const };
  const dealsLine = dealCount > 0 ? (asked.kind === "move" ? " Their deals move with them." : " Their deals stay with them.") : "";

  return (
    <form onSubmit={onSubmit} className="@container stack-section" data-testid="lead-form">
      <p className="text-sm text-muted-foreground">An empty field is cleared. A {noun} needs an email or a LinkedIn profile.</p>
      {GROUPS.map((group) => (
        <fieldset key={group.legend} className="stack-group min-w-0">
          <legend className="mb-1 text-sm font-medium">{group.legend}</legend>
          <div className="grid items-start gap-group @md:grid-cols-2">
            {group.fields.map((f) => (
              <div key={f.name} className={f.wide ? "stack-field @md:col-span-2" : "stack-field"}>
                <Label htmlFor={`lead-${f.name}`}>{f.label}</Label>
                <Input
                  id={`lead-${f.name}`}
                  type={f.type ?? "text"}
                  inputMode={f.inputMode}
                  autoComplete={f.autoComplete}
                  value={fields[f.name]}
                  placeholder={f.placeholder}
                  aria-describedby={f.help ? `lead-${f.name}-help` : undefined}
                  className="max-sm:h-11"
                  onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
                />
                {f.help && (
                  <p id={`lead-${f.name}-help`} className="text-xs text-muted-foreground">
                    {f.help}
                  </p>
                )}
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="stack-group min-w-0" data-testid="lead-form-company">
        <legend className="mb-1 text-sm font-medium">Company</legend>
        {!changing ? (
          <div className="stack-field text-sm">
            <p>
              {storedHref ? (
                <Link href={storedHref} className="font-medium underline-offset-4 hover:underline">
                  {oldCompany}
                </Link>
              ) : (
                <span className="font-medium">{oldCompany}</span>
              )}
              {initial.companyName.trim() && <span className="text-muted-foreground"> ({initial.companyDomain})</span>}
            </p>
            <p className="text-xs text-muted-foreground">Rename the company on its page.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="max-sm:h-11"
                onClick={() => {
                  setFields({ ...fields, companyDomain: "", companyName: "" });
                  setChanging(true);
                }}
              >
                Change company
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="max-sm:h-11"
                onClick={() => {
                  setFields({ ...fields, companyDomain: "", companyName: "" });
                  setChanging(true);
                }}
              >
                Remove company
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-group @md:grid-cols-2">
            <CompanyDomainField id="lead-companyDomain" value={fields.companyDomain} onChange={(value) => setFields({ ...fields, companyDomain: value })} lookup={lookup} autoFocus={hadCompany} />
            {lookup.status === "found" ? (
              <CompanyJoinLine company={lookup.company} typedName={fields.companyName} />
            ) : (
              <div className="stack-field">
                <Label htmlFor="lead-companyName">Company name</Label>
                <Input
                  id="lead-companyName"
                  value={fields.companyName}
                  autoComplete="off"
                  aria-describedby="lead-companyName-help"
                  className="max-sm:h-11"
                  onChange={(e) => setFields({ ...fields, companyName: e.target.value })}
                />
                <p id="lead-companyName-help" className="text-xs text-muted-foreground">
                  Names the company when the domain is new.
                </p>
              </div>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="stack-group min-w-0">
        <legend className="mb-1 text-sm font-medium">Custom fields</legend>
        <div className="grid gap-group @md:grid-cols-2">
          {customFields.map((c) => (
            <div key={c.key} className="stack-field">
              <Label htmlFor={`custom-${c.key}`}>{c.name}</Label>
              <Input id={`custom-${c.key}`} value={custom[c.key] ?? ""} className="max-sm:h-11" onChange={(e) => setCustom({ ...custom, [c.key]: e.target.value })} />
            </div>
          ))}
          {added.map((a, i) => (
            <div key={i} className="stack-field">
              <Input
                aria-label="New field name"
                placeholder="Field name"
                value={a.label}
                className="max-sm:h-11"
                onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <Input
                aria-label="New field value"
                placeholder="Value"
                value={a.value}
                className="max-sm:h-11"
                onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
            </div>
          ))}
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={() => setAdded([...added, { label: "", value: "" }])}>
            Add custom field
          </Button>
        </div>
      </fieldset>

      {errors.length > 0 && (
        <ul role="alert" className="grid gap-1 text-sm text-destructive">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || lookup.status === "checking"} className="max-sm:h-11">
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} className="max-sm:h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (open) return;
          setAsking(null);
          // Closing without Move or Remove keeps the old company and saves the other edits.
          if (!decided.current) keepOldCompany();
        }}
        title={asked.kind === "move" ? `Move ${person} to ${asked.to}?` : `Remove ${person} from ${oldCompany}?`}
        description={`${person} leaves ${oldCompany}.${dealsLine}`}
        confirmLabel={asked.kind === "move" ? "Move" : "Remove"}
        cancelLabel={`Keep ${oldCompany}`}
        onConfirm={() => {
          decided.current = true;
          void save(false);
        }}
      />
    </form>
  );
}
