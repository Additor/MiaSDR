"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { AsideSection } from "../../_components/record/record-header";

interface CustomField {
  key: string;
  name: string;
  value: string;
}

/**
 * The company's facts, read first, and Edit for the name, LinkedIn page and company fields. The header already shows the
 * domain and LinkedIn page, so the panel lists the rest. The domain is the company's identity and has no edit: a person
 * moves to another company through their own form.
 */
export function CompanyDetails({
  id,
  domain,
  created,
  initial,
  customFields,
  otherDomains = [],
}: {
  id: string;
  domain: string;
  /** Domains the company took over in a merge, with the removed company's name when known. The UI never says "alias". */
  otherDomains?: Array<{ domain: string; mergedName: string | null }>;
  /** ISO timestamp. */
  created: string;
  initial: { name: string; linkedin: string };
  /** The organization's company fields, in Settings order, with this company's values. */
  customFields: CustomField[];
}) {
  const [editing, setEditing] = useState(false);
  const filled = customFields.filter((c) => c.value.trim() !== "");

  return (
    <AsideSection
      title="Details"
      testId="company-details"
      action={
        !editing && (
          <Button variant="ghost" size="sm" className="max-sm:h-11" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <CompanyForm id={id} domain={domain} initial={initial} customFields={customFields} onDone={() => setEditing(false)} />
      ) : (
        <dl className="stack-group text-sm">
          <Fact label="Name">{initial.name || <span className="text-muted-foreground">Not set, the domain stands in</span>}</Fact>
          {otherDomains.length > 0 && (
            <Fact label="Other domains">
              <ul className="grid gap-1" data-testid="company-other-domains">
                {otherDomains.map((alias) => (
                  <li key={alias.domain}>
                    {alias.domain}
                    {alias.mergedName && <span className="text-muted-foreground">{` (was ${alias.mergedName})`}</span>}
                  </li>
                ))}
              </ul>
            </Fact>
          )}
          {filled.map((c) => (
            <Fact key={c.key} label={c.name}>
              {c.value}
            </Fact>
          ))}
          {filled.length === 0 && (
            <Fact label="Fields">
              <span className="text-muted-foreground">None filled in</span>
            </Fact>
          )}
          <Fact label="Added">
            <Time value={created} dateOnly />
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

function CompanyForm({
  id,
  domain,
  initial,
  customFields,
  onDone,
}: {
  id: string;
  domain: string;
  initial: { name: string; linkedin: string };
  customFields: CustomField[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [linkedin, setLinkedin] = useState(initial.linkedin);
  const [custom, setCustom] = useState<Record<string, string>>(Object.fromEntries(customFields.map((c) => [c.key, c.value])));
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    const result = await callApi(`/api/companies/${id}`, "PATCH", { name, linkedin, custom });
    setPending(false);
    if (!result.ok) {
      setErrors(result.issues.length > 0 ? result.issues.map((i) => i.message) : [result.error ?? "Could not save."]);
      return;
    }
    toast.success("Company saved.");
    onDone();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="stack-group" data-testid="company-form">
      <p className="text-sm text-muted-foreground">An empty field is cleared. The domain identifies the company and stays as it is.</p>
      <div className="stack-field">
        <Label htmlFor="company-name">Name</Label>
        <Input id="company-name" value={name} autoComplete="off" placeholder={domain} className="max-sm:h-11" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="stack-field">
        <Label htmlFor="company-linkedin">LinkedIn page</Label>
        <Input
          id="company-linkedin"
          value={linkedin}
          inputMode="url"
          autoComplete="off"
          placeholder="https://www.linkedin.com/company/name"
          className="max-sm:h-11"
          onChange={(e) => setLinkedin(e.target.value)}
        />
      </div>
      <fieldset className="stack-group min-w-0">
        <legend className="mb-1 text-sm font-medium">Company fields</legend>
        {customFields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet.{" "}
            <Link href="/settings/columns" className="underline underline-offset-4 hover:text-foreground">
              Custom fields
            </Link>{" "}
            in Settings adds them.
          </p>
        ) : (
          customFields.map((c) => (
            <div key={c.key} className="stack-field">
              <Label htmlFor={`company-custom-${c.key}`}>{c.name}</Label>
              <Input id={`company-custom-${c.key}`} value={custom[c.key] ?? ""} className="max-sm:h-11" onChange={(e) => setCustom({ ...custom, [c.key]: e.target.value })} />
            </div>
          ))
        )}
      </fieldset>
      {errors.length > 0 && (
        <ul role="alert" className="grid gap-1 text-sm text-destructive">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending} className="max-sm:h-11">
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} className="max-sm:h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
