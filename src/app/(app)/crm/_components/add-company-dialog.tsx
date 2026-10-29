"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { CompanyDomainField, companyName, useCompanyDomainLookup, type ResolvedCompany } from "@/app/(app)/_components/person/company-domain-field";

/**
 * Add company: a company from a domain and an optional name and LinkedIn page, listed in Companies from the start.
 * The live lookup says first when a company already holds the domain: a listed company or another domain of one holds the
 * confirm and links to that company; a company with leads only joins Companies on confirm.
 */

/** The domain as a person reads it in a sentence: lowercase, without the scheme, `www.` or a path. */
const shownDomain = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];

/** What holds the typed domain, from the lookup or from a 409 `company_exists`. */
interface Holder {
  company: Pick<ResolvedCompany, "companyId" | "name" | "domain" | "viaAlias" | "listed">;
  /** The typed domain, which differs from the company's own domain when `viaAlias`. */
  typed: string;
}

function HolderLines({ holder }: { holder: Holder }) {
  const name = companyName(holder.company);
  if (!holder.company.viaAlias && !holder.company.listed) {
    return <p className="text-sm">{name} has leads and is not in Companies yet. Add company lists it.</p>;
  }
  return (
    <div className="stack-group text-sm">
      <p>{holder.company.viaAlias ? `${holder.typed} is another domain of ${name}.` : `${name} already uses ${holder.company.domain}.`}</p>
      <div>
        <Link href={`/crm/companies/${holder.company.companyId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open {name}
        </Link>
      </div>
    </div>
  );
}

export function AddCompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [linkedin, setLinkedin] = useState("");
  /** A 409 `company_exists` for the domain as it was sent. */
  const [conflict, setConflict] = useState<Holder | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const lookup = useCompanyDomainLookup(domain);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDomain("");
      setName("");
      setLinkedin("");
      setConflict(null);
    }
  }

  const typed = shownDomain(domain);
  const holder: Holder | null =
    conflict && conflict.typed === typed ? conflict : lookup.status === "found" ? { company: lookup.company, typed } : null;
  /** A listed company or another domain of one: nothing to add. */
  const taken = holder !== null && (holder.company.viaAlias || holder.company.listed);

  async function add(): Promise<boolean> {
    const joining = holder && !taken ? holder.company : null;
    const body = { domain: domain.trim(), name: joining ? null : name.trim() || null, linkedinUrl: joining ? null : linkedin.trim() || null };
    // A success opens the new company, so nothing reloads this page.
    const result = await runApiAction(callApi<{ companyId: string; listed: boolean }>("/api/companies", "POST", body), { expectData: true });
    if (result.ok) {
      toast.success(joining ? `Added ${companyName(joining)} to Companies.` : `Added ${name.trim() || typed}.`);
      router.push(`/crm/companies/${result.data.companyId}`);
      return true;
    }
    const details = result.details;
    if (result.code === "company_exists" && typeof details?.companyId === "string") {
      setConflict({
        company: {
          companyId: details.companyId,
          name: typeof details.name === "string" ? details.name : null,
          domain: typeof details.domain === "string" ? details.domain : typed,
          viaAlias: details.viaAlias === true,
          listed: true,
        },
        typed,
      });
      return false;
    }
    throw new Error(result.error);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add company"
      description=""
      confirmLabel="Add company"
      pendingLabel="Adding…"
      confirmDisabled={lookup.status === "empty" || lookup.status === "checking" || lookup.status === "invalid" || taken}
      className="sm:max-w-md [&_[data-slot=dialog-description]:empty]:hidden"
      onConfirm={add}
    >
      <form className="stack-group" data-testid="add-company-form" onSubmit={(e) => e.preventDefault()}>
        <CompanyDomainField id={`${id}-domain`} value={domain} onChange={setDomain} lookup={lookup} autoFocus />
        {holder && (
          <div role="status">
            <HolderLines holder={holder} />
          </div>
        )}
        {/* A company that exists keeps its name and LinkedIn page; it edits them on its own page. */}
        {!holder && (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input id={`${id}-name`} value={name} placeholder={domain.trim()} autoComplete="off" touch onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-linkedin`}>LinkedIn page</FieldLabel>
              <Input
                id={`${id}-linkedin`}
                value={linkedin}
                inputMode="url"
                placeholder="https://www.linkedin.com/company/acme"
                autoComplete="off"
                touch
                onChange={(e) => setLinkedin(e.target.value)}
              />
            </Field>
          </>
        )}
      </form>
    </ConfirmDialog>
  );
}

/** An Add company button with its dialog. */
export function AddCompanyButton({ label = "Add company", variant = "default", className }: { label?: string; variant?: "default" | "outline"; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AddCompanyDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
