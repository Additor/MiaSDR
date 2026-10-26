"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";
import { AdminNotice } from "../admin-notice";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { SettingsSection } from "../settings-section";
import { TimeZoneSelect } from "../time-zone-select";
import { CountrySelect } from "./country-select";

interface Org {
  name: string;
  slug: string;
  timeZone: string;
  defaultPhoneCountry: string | null;
}

export function OrganizationForm({ org, zones, canRename, canEditZone }: { org: Org; zones: string[]; canRename: boolean; canEditZone: boolean }) {
  const router = useRouter();
  const saved = { name: org.name, timeZone: org.timeZone, country: org.defaultPhoneCountry ?? "" };
  const [values, setValues] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = values.name.trim() !== saved.name || values.timeZone !== saved.timeZone || values.country !== saved.country;
  useLeaveGuard(dirty);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/organization", "PATCH", {
      ...(canRename ? { name: values.name } : {}),
      timeZone: values.timeZone,
      defaultPhoneCountry: values.country || null,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Organization saved.");
    router.refresh();
  }

  return (
    <SettingsSection title="Details" description="The owner renames the organization. Owners and admins change the time zone and the default phone country.">
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} maxLength={80} required disabled={!canRename} className="max-w-sm" />
            <FieldDescription>
              {canEditZone && !canRename ? "Only the owner can rename the organization. " : ""}Its address in links is <span className="font-mono text-foreground">{org.slug}</span>, which never changes.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="timeZone">Default time zone</FieldLabel>
            <TimeZoneSelect id="timeZone" zones={zones} value={values.timeZone} onValueChange={(timeZone) => setValues({ ...values, timeZone })} disabled={!canEditZone} />
            <FieldDescription>Days, dates and the AI&apos;s daily limit follow this zone. Mailboxes on organization hours send Monday to Friday, 09:00 to 18:00 in it.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="defaultPhoneCountry">Default country for phone numbers</FieldLabel>
            <CountrySelect id="defaultPhoneCountry" value={values.country} onValueChange={(country) => setValues({ ...values, country })} disabled={!canEditZone} describedBy="defaultPhoneCountry-help" />
            <FieldDescription id="defaultPhoneCountry-help">
              Lead imports and lead edits read a number without a country code, such as 010-1234-5678, as a number from this country. With no default, such a number is ignored with a warning, unless your administrator set a default country in the server configuration.
            </FieldDescription>
          </Field>
          {canEditZone ? <SaveRow dirty={dirty} pending={pending} error={error} onDiscard={() => setValues(saved)} /> : <AdminNotice action="change these settings" />}
        </FieldGroup>
      </form>
    </SettingsSection>
  );
}
