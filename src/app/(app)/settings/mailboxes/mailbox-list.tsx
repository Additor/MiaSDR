"use client";

import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorWithLinks } from "@/components/shell/error-with-links";
import { StatusBadge } from "@/components/shell/status-badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/app/_lib/api-client";
import type { TestSendResult } from "@/contexts/outreach/email/application/send-test-email";
import { formatCount } from "@/shared/format-number";
import { cn } from "@/components/ui/utils";
import { AdminNotice } from "../admin-notice";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";
import { hoursDraft, hoursSummary, sameHours, toStoredHours, WorkingHoursFields, type StoredHours } from "../working-hours-fields";

interface Mailbox {
  id: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  lastError: string | null;
  dailySendLimit: number;
  signatureHtml: string | null;
  workingHours: StoredHours | null;
  /** False while the mailbox follows the organization's hours; `workingHours` then holds that default. */
  ownHours: boolean;
  sentToday: number;
  waitingLeads: number;
}

/** What happens to leads waiting on a mailbox that stops sending. */
function waitingWarning(count: number, hours: number) {
  return `${formatCount(count)} lead${count === 1 ? " waits" : "s wait"} for follow-ups on this mailbox; after ${hours} hour${hours === 1 ? "" : "s"} another mailbox takes over and the thread breaks.`;
}

/** Mirrors the send-time domain policy: a connected mailbox outside the list (or any mailbox under open sign-up without a list) does not send. */
function domainAllowed(emailAddress: string, allowedDomains: string[] | null, signupBlocked: boolean): boolean {
  if (allowedDomains) return allowedDomains.includes(emailAddress.slice(emailAddress.lastIndexOf("@") + 1).toLowerCase());
  return !signupBlocked;
}

export function MailboxList({
  mailboxes,
  canManage,
  takeoverAfterHours,
  allowedDomains,
  signupBlocked,
  zones,
  defaultTimeZone,
  rules,
}: {
  mailboxes: Mailbox[];
  canManage: boolean;
  takeoverAfterHours: number;
  allowedDomains: string[] | null;
  signupBlocked: boolean;
  zones: string[];
  defaultTimeZone: string;
  /** The sending rules block, which closes the page. */
  rules: ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const result = await callApi("/api/mailboxes", "POST", { emailAddress: data.get("emailAddress"), displayName: data.get("displayName") || undefined });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    form.reset();
    router.refresh();
  }

  async function act(label: string, run: () => Promise<{ ok: boolean; error: string | null }>) {
    const result = await run();
    if (!result.ok) toast.error(result.error ?? `${label} failed.`);
    else toast.success(`${label}.`);
    router.refresh();
  }

  return (
    <div>
      <div className="stack-group pb-section">
        <p className="text-sm text-muted-foreground">
          Campaigns send from your Google Workspace mailboxes. Enter an address and MiaSDR asks Google whether the server&apos;s Google connection can send as it. The address also has to be in a domain your administrator allows. A mailbox sends only while its status is Connected.
        </p>
        {!canManage && <AdminNotice action="connect or change mailboxes" />}
      </div>
      {canManage && (
        <SettingsSection
          title="Connect a mailbox"
          description={
            <>
              Enter the address campaigns should send from.
              {allowedDomains
                ? ` Allowed domains: ${allowedDomains.join(", ")}.`
                : signupBlocked
                  ? " Connecting is disabled until your administrator limits which domains can be connected in the server configuration."
                  : ""}
            </>
          }
        >
          <form onSubmit={connect}>
            <FieldGroup>
              <div className="grid gap-group sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="emailAddress">Email address</FieldLabel>
                  <Input id="emailAddress" name="emailAddress" type="email" required autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="displayName">Sender name (optional)</FieldLabel>
                  <Input id="displayName" name="displayName" placeholder="Ada from Acme" />
                </Field>
              </div>
              {error && <FieldError>{error}</FieldError>}
              <div>
                <Button type="submit" disabled={pending}>
                  {pending ? "Connecting…" : "Connect mailbox"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </SettingsSection>
      )}

      <SettingsSection
        title="Mailboxes"
        description={canManage && mailboxes.length > 0 ? "Recheck connection asks Google whether MiaSDR can still send as an address. To deliver one real message, open More and choose Send test email." : undefined}
      >
        {mailboxes.length === 0 ? (
          <EmptyState
            title="No mailboxes yet"
            description={canManage ? "Campaigns cannot send until one mailbox is connected." : "Campaigns cannot send until an owner or admin connects a mailbox."}
            action={
              canManage ? (
                <Button variant="outline" onClick={() => document.getElementById("emailAddress")?.focus()}>
                  Connect a mailbox
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className={RULED_LIST}>
            {mailboxes.map((mailbox) => (
              <li key={mailbox.id} data-testid="mailbox-row" className={cn(RULED_ROW, "stack-group")}>
                <div className="stack-field">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="heading-item break-all">{mailbox.emailAddress}</h3>
                    <StatusBadge status={mailbox.status} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {mailbox.displayName ? `${mailbox.displayName}. ` : ""}
                    {formatCount(mailbox.sentToday)} of {formatCount(mailbox.dailySendLimit)} sent today.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {hoursSummary(hoursDraft(mailbox.workingHours, defaultTimeZone))}
                    {mailbox.ownHours ? "" : " (organization hours)"}
                  </p>
                </div>
                {mailbox.waitingLeads > 0 && mailbox.status !== "connected" && (
                  // Leads still wait on this mailbox: a degraded state, so the icon takes the warning hue.
                  <p role="status" className="flex items-start gap-2 text-sm">
                    <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                    {waitingWarning(mailbox.waitingLeads, takeoverAfterHours)}
                  </p>
                )}
                {mailbox.status === "connected" && !domainAllowed(mailbox.emailAddress, allowedDomains, signupBlocked) && (
                  <p role="alert" className="text-sm text-destructive">
                    Blocked: this address is outside the domains your administrator allows. Connect an address in an allowed domain, or ask your administrator to add this one.
                  </p>
                )}
                {mailbox.lastError && (
                  <p role="alert" className="text-sm text-destructive">
                    <ErrorWithLinks text={mailbox.lastError} />
                  </p>
                )}
                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => act("Connection checked", () => callApi(`/api/mailboxes/${mailbox.id}/test`, "POST"))}>
                      Recheck connection
                    </Button>
                    <EditMailbox mailbox={mailbox} zones={zones} defaultTimeZone={defaultTimeZone} onSaved={() => router.refresh()} />
                    <MailboxMenu mailbox={mailbox} takeoverAfterHours={takeoverAfterHours} act={act} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {rules}
    </div>
  );
}

const NO_WAITING_LEADS = "No leads are waiting on this mailbox.";

type MailboxDialog = "test" | "disable" | "remove" | null;

/** Secondary actions. The dialogs live outside the menu so they stay open after the menu closes. */
function MailboxMenu({
  mailbox,
  takeoverAfterHours,
  act,
}: {
  mailbox: Mailbox;
  takeoverAfterHours: number;
  act: (label: string, run: () => Promise<{ ok: boolean; error: string | null }>) => Promise<void>;
}) {
  const [dialog, setDialog] = useState<MailboxDialog>(null);
  const warning = mailbox.waitingLeads > 0 ? waitingWarning(mailbox.waitingLeads, takeoverAfterHours) : null;
  const onOpenChange = (next: boolean) => {
    if (!next) setDialog(null);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`More actions for ${mailbox.emailAddress}`} />}>More</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          {mailbox.status === "connected" && <DropdownMenuItem onClick={() => setDialog("test")}>Send test email</DropdownMenuItem>}
          {mailbox.status === "disabled" ? (
            <DropdownMenuItem onClick={() => act("Enabled", () => callApi(`/api/mailboxes/${mailbox.id}/enabled`, "POST", { enabled: true }))}>Enable</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setDialog("disable")}>Disable</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("remove")}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {mailbox.status === "connected" && <TestSendDialog mailbox={mailbox} open={dialog === "test"} onOpenChange={onOpenChange} />}
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={onOpenChange}
        title={`Disable ${mailbox.emailAddress}?`}
        description={warning ?? NO_WAITING_LEADS}
        confirmLabel="Disable"
        pendingLabel="Disabling…"
        onConfirm={() => act("Disabled", () => callApi(`/api/mailboxes/${mailbox.id}/enabled`, "POST", { enabled: false }))}
      />
      {mailbox.waitingLeads > 0 ? (
        <ConfirmDialog
          open={dialog === "remove"}
          onOpenChange={onOpenChange}
          title={`${mailbox.emailAddress} cannot be removed`}
          description="A mailbox with leads in a sequence cannot be removed. Disable it instead, or finish those sequences first."
          confirmLabel="Disable instead"
          pendingLabel="Disabling…"
          onConfirm={() => act("Disabled", () => callApi(`/api/mailboxes/${mailbox.id}/enabled`, "POST", { enabled: false }))}
        >
          {warning && <p className="text-sm text-muted-foreground">{warning}</p>}
        </ConfirmDialog>
      ) : (
        <ConfirmDialog
          open={dialog === "remove"}
          onOpenChange={onOpenChange}
          title={`Remove ${mailbox.emailAddress}?`}
          description={NO_WAITING_LEADS}
          confirmLabel="Remove mailbox"
          cancelLabel="Keep mailbox"
          pendingLabel="Removing…"
          destructive
          onConfirm={() => act("Removed", () => callApi(`/api/mailboxes/${mailbox.id}`, "DELETE"))}
        />
      )}
    </>
  );
}

/** Sender name, daily limit, hours and signature of one mailbox, in the shared confirm dialog. */
function EditMailbox({ mailbox, zones, defaultTimeZone, onSaved }: { mailbox: Mailbox; zones: string[]; defaultTimeZone: string; onSaved: () => void }) {
  const saved = {
    displayName: mailbox.displayName ?? "",
    limit: String(mailbox.dailySendLimit),
    signature: mailbox.signatureHtml ?? "",
    // A mailbox without its own hours follows the organization's zone, so saving keeps it unset until someone picks Custom.
    hoursMode: mailbox.ownHours ? "custom" : "organization",
    hours: hoursDraft(mailbox.ownHours ? mailbox.workingHours : null, defaultTimeZone),
  };
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(saved);
  const dirty =
    values.displayName.trim() !== saved.displayName ||
    Number(values.limit) !== mailbox.dailySendLimit ||
    values.signature.trim() !== saved.signature.trim() ||
    values.hoursMode !== saved.hoursMode ||
    (values.hoursMode === "custom" && !sameHours(values.hours, saved.hours));

  async function save() {
    if (values.hoursMode === "custom" && values.hours.days.length === 0) throw new Error("Pick at least one sending day, or use organization hours.");
    const result = await callApi(`/api/mailboxes/${mailbox.id}`, "PATCH", {
      displayName: values.displayName.trim() || null,
      dailySendLimit: Number(values.limit),
      signatureHtml: values.signature.trim() || null,
      workingHours: values.hoursMode === "organization" ? null : toStoredHours(values.hours),
    });
    if (!result.ok) throw new Error(result.error ?? "Could not save the mailbox.");
    toast.success("Mailbox saved.");
    onSaved();
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          // Opening starts from what is saved, not from an abandoned edit.
          setValues(saved);
          setOpen(true);
        }}
      >
        Edit mailbox
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Edit ${mailbox.emailAddress}`}
        description="These settings apply to this mailbox only."
        confirmLabel="Save"
        pendingLabel="Saving…"
        confirmDisabled={!dirty}
        className="sm:max-w-lg"
        onConfirm={save}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${mailbox.id}-name`}>Sender name</FieldLabel>
            <Input id={`${mailbox.id}-name`} value={values.displayName} onChange={(e) => setValues({ ...values, displayName: e.target.value })} placeholder="Ada from Acme" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${mailbox.id}-limit`}>Emails per day</FieldLabel>
            <Input id={`${mailbox.id}-limit`} type="number" min={1} max={200} value={values.limit} onChange={(e) => setValues({ ...values, limit: e.target.value })} className="w-28" required />
            <FieldDescription>1 to 200. Test emails do not count.</FieldDescription>
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Sending hours</FieldLegend>
            <RadioGroup value={values.hoursMode} onValueChange={(v) => setValues({ ...values, hoursMode: v as "organization" | "custom" })}>
              <Field orientation="horizontal">
                <RadioGroupItem value="organization" id={`${mailbox.id}-hours-org`} />
                <FieldContent>
                  <FieldLabel htmlFor={`${mailbox.id}-hours-org`}>Organization hours</FieldLabel>
                  <FieldDescription>Monday to Friday, 09:00 to 18:00, {defaultTimeZone}. Follows the organization&apos;s time zone when it changes.</FieldDescription>
                </FieldContent>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem value="custom" id={`${mailbox.id}-hours-custom`} />
                <FieldLabel htmlFor={`${mailbox.id}-hours-custom`}>Custom hours for this mailbox</FieldLabel>
              </Field>
            </RadioGroup>
          </FieldSet>
          {values.hoursMode === "custom" && <WorkingHoursFields id={`${mailbox.id}-hours`} value={values.hours} onChange={(hours) => setValues({ ...values, hours })} zones={zones} />}
          <Field>
            <FieldLabel htmlFor={`${mailbox.id}-signature`}>Signature</FieldLabel>
            <Textarea id={`${mailbox.id}-signature`} rows={4} value={values.signature} onChange={(e) => setValues({ ...values, signature: e.target.value })} placeholder={"Ada Lovelace\nAcme"} />
            <FieldDescription>Goes at the end of each email from this mailbox, or where a step says %signature%.</FieldDescription>
          </Field>
        </FieldGroup>
      </ConfirmDialog>
    </>
  );
}

/**
 * Sends one test email through the normal send claim, and shows the outcome in words. The dialog stays open after a send,
 * so the outcome sits in the body and a second address can follow; a refused request shows ConfirmDialog's error line.
 */
function TestSendDialog({ mailbox, open, onOpenChange }: { mailbox: Mailbox; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [to, setTo] = useState("");
  const [result, setResult] = useState<TestSendResult | null>(null);

  function change(next: boolean) {
    // Every opening starts without the last address or result.
    if (!next) {
      setTo("");
      setResult(null);
    }
    onOpenChange(next);
  }

  async function send() {
    setResult(null);
    const response = await callApi<TestSendResult>(`/api/mailboxes/${mailbox.id}/send-test`, "POST", { to: to.trim() });
    if (!response.ok) throw new Error(response.error ?? "Could not send the test email.");
    setResult(response.data);
    return false;
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={`Send a test email from ${mailbox.emailAddress}`}
      description="The test goes through the same checks as a campaign email. A mailbox sends 3 test emails per hour, and test emails do not use the daily campaign limit."
      confirmLabel="Send test"
      pendingLabel="Sending…"
      cancelLabel={result ? "Close" : "Cancel"}
      confirmDisabled={to.trim() === ""}
      onConfirm={send}
    >
      <Field>
        <FieldLabel htmlFor={`test-to-${mailbox.id}`}>Send to</FieldLabel>
        <Input id={`test-to-${mailbox.id}`} type="email" required placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      {result && (
        // A delivered test is the normal outcome, so it reads in the foreground with a check; anything else is an error.
        <p role={result.status === "sent" ? "status" : "alert"} data-testid="test-send-result" className={cn("flex items-start gap-2 text-sm", result.status !== "sent" && "text-destructive")}>
          {result.status === "sent" && <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          {result.message}
        </p>
      )}
    </ConfirmDialog>
  );
}
