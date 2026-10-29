"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";

/**
 * The Website or domain field with its live lookup, shared by Add contact, Add company and the person form. 300 ms
 * after typing stops, the lookup asks `GET /api/companies/resolve` which company holds the domain, as its own domain or as
 * another domain. The caller reads the answer from `useCompanyDomainLookup` and decides what it means for its form: Add contact
 * and the person form show `CompanyJoinLine`, Add company shows its own lines.
 */

export const LOOKUP_DELAY_MS = 300;

/** A company that holds the typed domain: the body of `GET /api/companies/resolve`. */
export interface ResolvedCompany {
  companyId: string;
  name: string | null;
  /** The company's own domain, which differs from the typed one when `viaAlias`. */
  domain: string;
  viaAlias: boolean;
  /** Listed in Companies. */
  listed: boolean;
}

export type DomainLookup =
  | { status: "empty" }
  | { status: "checking" }
  /** A 422: not a domain, or an email provider. `message` is the server's sentence. */
  | { status: "invalid"; message: string }
  /** The lookup failed for another reason. The form can still save, and the server checks the domain again. */
  | { status: "unavailable"; message: string }
  | { status: "new" }
  | { status: "found"; company: ResolvedCompany };

type Settled = Exclude<DomainLookup, { status: "empty" } | { status: "checking" }>;

/** The company's name, or its domain when it has none. */
export const companyName = (company: Pick<ResolvedCompany, "name" | "domain">) => company.name?.trim() || company.domain;

/** Looks up `value` once typing stops. The answer for an older value never shows for a newer one. */
export function useCompanyDomainLookup(value: string): DomainLookup {
  const query = value.trim();
  const [settled, setSettled] = useState<{ query: string; lookup: Settled } | null>(null);

  useEffect(() => {
    if (!query) return;
    let live = true;
    const timer = setTimeout(async () => {
      const result = await callApi<{ company: ResolvedCompany | null }>(`/api/companies/resolve?domain=${encodeURIComponent(query)}`, "GET");
      if (!live) return;
      let lookup: Settled;
      if (result.ok) lookup = result.data?.company ? { status: "found", company: result.data.company } : { status: "new" };
      else if (isValidationAnswer(result.details)) lookup = { status: "invalid", message: result.error ?? "Type a company domain or website." };
      else lookup = { status: "unavailable", message: result.error ?? "MiaSDR could not check this domain." };
      setSettled({ query, lookup });
    }, LOOKUP_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  if (!query) return { status: "empty" };
  if (settled?.query !== query) return { status: "checking" };
  return settled.lookup;
}

/** A 422 body carries `issues` next to its sentence; other refusals (a 500, a lost session, no network) do not. */
function isValidationAnswer(details: Record<string, unknown> | null): boolean {
  return Array.isArray(details?.issues);
}

/**
 * The input, its label and the lookup's own line under it: "Checking…" while the lookup runs, the server's sentence for a
 * domain it refuses, or why the lookup failed. A found or new company is the caller's to describe.
 */
export function CompanyDomainField({
  id,
  value,
  onChange,
  lookup,
  label = "Website or domain",
  placeholder = "acme.com",
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  lookup: DomainLookup;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const statusId = `${id}-lookup`;
  const line =
    lookup.status === "checking" ? (
      <p id={statusId} className="text-xs text-muted-foreground">
        Checking…
      </p>
    ) : lookup.status === "invalid" ? (
      <p id={statusId} className="text-xs text-destructive">
        {lookup.message}
      </p>
    ) : lookup.status === "unavailable" ? (
      <p id={statusId} className="text-xs text-muted-foreground">
        {lookup.message}
      </p>
    ) : null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={autoFocus}
        aria-invalid={lookup.status === "invalid" || undefined}
        aria-describedby={line ? statusId : undefined}
        touch
        onChange={(e) => onChange(e.target.value)}
      />
      {/* One live region for the lookup, so a screen reader hears "Checking…" and the answer without moving focus. */}
      <div aria-live="polite" className="contents">
        {line}
      </div>
    </Field>
  );
}

/**
 * The read-only company line of Add contact and the person form for a domain that a company already holds:
 * "Joins Acme (acme.com)." linking to the company page. With a name typed before the lookup answered, the note under it says
 * MiaSDR drops that name.
 */
export function CompanyJoinLine({ company, typedName }: { company: ResolvedCompany; typedName?: string | null }) {
  const name = companyName(company);
  const dropped = Boolean(typedName?.trim()) && typedName?.trim() !== company.name?.trim();
  return (
    <div className="stack-field text-sm" data-testid="company-join">
      <p>
        Joins{" "}
        <Link href={`/crm/companies/${company.companyId}`} className="font-medium underline-offset-4 hover:underline">
          {name}
        </Link>{" "}
        ({company.domain}).
      </p>
      {dropped && <p className="text-xs text-muted-foreground">MiaSDR drops the name you typed. Rename {name} on its company page.</p>}
    </div>
  );
}
