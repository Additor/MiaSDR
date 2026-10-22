"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { AdminNotice } from "../admin-notice";
import { SettingsSection } from "../settings-section";
import { TimeZoneSelect } from "../time-zone-select";

interface Org {
  name: string;
  slug: string;
  timeZone: string;
  defaultPhoneCountry: string | null;
}

export function OrganizationForm({ org, zones, canRename, canEditZone }: { org: Org; zones: string[]; canRename: boolean; canEditZone: boolean }) {
  const router = useRouter();
  const [timeZone, setTimeZone] = useState(org.timeZone);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/organization", "PATCH", {
      ...(canRename ? { name: String(data.get("name") ?? "") } : {}),
      timeZone,
      defaultPhoneCountry: String(data.get("defaultPhoneCountry") ?? "").trim().toUpperCase() || null,
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
      <form onSubmit={onSubmit} className="stack-group">
        <div className="stack-field">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={org.name} maxLength={80} required disabled={!canRename} />
        </div>
        <div className="stack-field">
          <Label htmlFor="slug">Slug</Label>
          <Input id="slug" value={org.slug} readOnly disabled className="max-w-sm" />
          <p className="text-sm text-muted-foreground">The slug is fixed.</p>
        </div>
        <div className="stack-field">
          <Label htmlFor="timeZone">Default time zone</Label>
          <TimeZoneSelect id="timeZone" zones={zones} value={timeZone} onValueChange={setTimeZone} disabled={!canEditZone} />
          <p className="text-sm text-muted-foreground">Mailboxes without their own working hours use this zone, Monday to Friday, 09:00 to 18:00.</p>
        </div>
        <div className="stack-field">
          <Label htmlFor="defaultPhoneCountry">Default country for phone numbers</Label>
          <Input
            id="defaultPhoneCountry"
            name="defaultPhoneCountry"
            defaultValue={org.defaultPhoneCountry ?? ""}
            disabled={!canEditZone}
            maxLength={2}
            placeholder="KR or US"
            aria-describedby="defaultPhoneCountry-help"
            className="max-w-40"
          />
          <p id="defaultPhoneCountry-help" className="text-sm text-muted-foreground">
            A two-letter country code, such as KR or US. Lead imports and lead edits read a number without a country code, such as 010-1234-5678, as a number from this country. While this is empty, such a number is ignored with a warning, unless your administrator set a default country in the server configuration.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {canEditZone ? (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <AdminNotice action="change these settings" />
        )}
        {canEditZone && !canRename && <p className="text-sm text-muted-foreground">Only the owner can rename the organization.</p>}
      </form>
    </SettingsSection>
  );
}
