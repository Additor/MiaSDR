"use client";

import Link from "next/link";
import { countOf } from "@/shared/format-number";
import { Time } from "@/components/shell/time";
import { callApi } from "@/app/_lib/api-client";
import { AddField } from "@/app/(app)/_components/person/person-details";
import { EditableFact, NotSet, type SaveResult } from "@/app/(app)/_components/record/inline-field";
import { AsideSection } from "@/app/(app)/_components/record/record-header";

interface CustomField {
  key: string;
  name: string;
  value: string;
}

/**
 * The company's facts, each one edited and saved on its own row: the name, the LinkedIn page and the company fields. The
 * domain is the company's identity and has no edit: a person moves to another company from their own Details. What
 * nobody edits here (the domains a merge brought, values of removed fields, when the company was added) closes the panel
 * in muted text.
 */
export function CompanyDetails({
  id,
  domain,
  created,
  initial,
  customFields,
  otherDomains = [],
  staleFields = [],
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
  /** Values under fields that were archived or removed. They stay, and no row edits them. */
  staleFields?: CustomField[];
}) {
  const save = (body: Record<string, unknown>) => saveCompany(id, body);
  const filled = customFields.filter((c) => c.value.trim() !== "");

  return (
    <AsideSection title="Details" testId="company-details">
      <dl className="stack-group text-sm">
        <EditableFact label="Name" saved="Company name saved." inputs={[{ key: "name", value: initial.name, placeholder: domain, help: "Empty shows the domain in its place." }]} onSave={save}>
          {initial.name || <NotSet>Not set, the domain stands in</NotSet>}
        </EditableFact>
        <EditableFact label="LinkedIn" saved="LinkedIn page saved." inputs={[{ key: "linkedin", value: initial.linkedin, inputMode: "url", placeholder: "https://www.linkedin.com/company/name" }]} onSave={save}>
          {initial.linkedin ? (
            <a href={initial.linkedin} target="_blank" rel="noopener noreferrer" aria-label="LinkedIn page (opens in a new tab)" className="rounded-sm underline-offset-4 hover:underline focus-ring">
              Page
            </a>
          ) : (
            <NotSet />
          )}
        </EditableFact>
        {filled.map((c) => (
          <EditableFact key={c.key} label={c.name} saved={`${c.name} saved.`} inputs={[{ key: c.key, value: c.value, help: "Empty removes the value." }]} onSave={(v) => save({ custom: { [c.key]: v[c.key] } })}>
            {c.value}
          </EditableFact>
        ))}
      </dl>
      <AddField
        fields={customFields}
        onSave={(field, value) => save({ custom: { [field.key]: value } })}
        settingsHint={
          customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <Link href="/settings/columns" className="rounded-sm underline underline-offset-4 hover:text-foreground focus-ring">
                Custom fields
              </Link>{" "}
              in Settings adds company fields.
            </p>
          ) : null
        }
      />
      <div className="grid gap-1 text-xs text-muted-foreground" data-testid="company-origin">
        {otherDomains.length > 0 && (
          <p data-testid="company-other-domains">
            Also uses{" "}
            {otherDomains.map((alias, index) => (
              <span key={alias.domain}>
                {index > 0 && ", "}
                <span className="text-foreground">{alias.domain}</span>
                {alias.mergedName && ` (was ${alias.mergedName})`}
              </span>
            ))}
            , from a merge.
          </p>
        )}
        <p>
          Added <Time value={created} dateOnly />.
        </p>
        {staleFields.length > 0 && (
          <details data-testid="company-other-values">
            <summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-ring max-sm:py-3">
              {countOf(staleFields.length, "value")} from removed fields
            </summary>
            <dl className="mt-2 grid gap-1 text-sm">
              {staleFields.map((field) => (
                <div key={field.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3">
                  <dt className="text-muted-foreground">{field.name}</dt>
                  <dd className="break-words text-foreground">{field.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </AsideSection>
  );
}

/** PATCH one change to the company. Leaves every field the body does not name as it is. */
async function saveCompany(id: string, body: Record<string, unknown>): Promise<SaveResult> {
  const result = await callApi(`/api/companies/${id}`, "PATCH", body);
  if (result.ok) return null;
  return result.issues[0]?.message ?? result.error ?? "Could not save.";
}
