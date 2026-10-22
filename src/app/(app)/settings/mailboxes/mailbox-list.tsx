"use client";

import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorWithLinks } from "@/components/shell/error-with-links";
import { StatusBadge } from "@/components/shell/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { AdminNotice } from "../admin-notice";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";
import { TimeZoneSelect } from "../time-zone-select";

interface WorkingHours {
  timeZone: string;
  days: Record<string, Array<{ start: string; end: string }>>;
}

interface Mailbox {
  id: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  lastError: string | null;
  dailySendLimit: number;
  signatureHtml: string | null;
  workingHours: WorkingHours | null;
  sentToday: number;
  waitingLeads: number;
}

const DAYS = [
  { key: "1", label: "Mon" },
  { key: "2", label: "Tue" },
  { key: "3", label: "Wed" },
  { key: "4", label: "Thu" },
  { key: "5", label: "Fri" },
  { key: "6", label: "Sat" },
  { key: "0", label: "Sun" },
];

/** What happens to leads waiting on a mailbox that stops sending. */
function waitingWarning(count: number, hours: number) {
  return `${count} lead${count === 1 ? " waits" : "s wait"} for follow-ups on this mailbox; after ${hours} hour${hours === 1 ? "" : "s"} another mailbox takes over and the thread breaks.`;
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
}: {
  mailboxes: Mailbox[];
  canManage: boolean;
  takeoverAfterHours: number;
  allowedDomains: string[] | null;
  signupBlocked: boolean;
  zones: string[];
  defaultTimeZone: string;
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
          <form onSubmit={connect} className="stack-group">
            <div className="grid gap-group sm:grid-cols-2">
              <div className="stack-field">
                <Label htmlFor="emailAddress">Email address</Label>
                <Input id="emailAddress" name="emailAddress" type="email" required />
              </div>
              <div className="stack-field">
                <Label htmlFor="displayName">Sender name (optional)</Label>
                <Input id="displayName" name="displayName" placeholder="Ada from Acme" />
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Connecting…" : "Connect mailbox"}
              </Button>
            </div>
          </form>
        </SettingsSection>
      )}

      <SettingsSection title="Mailboxes">
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
                    <h3 className="text-sm font-medium break-all">{mailbox.emailAddress}</h3>
                    <StatusBadge status={mailbox.status} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {mailbox.displayName ? `${mailbox.displayName}. ` : ""}
                    {mailbox.sentToday} of {mailbox.dailySendLimit} sent today.
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
                    <Button variant="outline" size="sm" onClick={() => act("Connection checked", () => callApi(`/api/mailboxes/${mailbox.id}/test`, "POST"))}>
                      Recheck connection
                    </Button>
                    <SettingsDialog mailbox={mailbox} zones={zones} defaultTimeZone={defaultTimeZone} onSaved={() => router.refresh()} />
                    <MailboxMenu mailbox={mailbox} takeoverAfterHours={takeoverAfterHours} act={act} />
                    {mailbox.status === "connected" && (
                      <p className="basis-full text-sm text-muted-foreground">Recheck connection asks Google whether MiaSDR can still send as this address. To deliver one real message, open More and choose Send test email.</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
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
          confirmLabel="Remove"
          pendingLabel="Removing…"
          destructive
          onConfirm={() => act("Removed", () => callApi(`/api/mailboxes/${mailbox.id}`, "DELETE"))}
        />
      )}
    </>
  );
}

function SettingsDialog({ mailbox, zones, defaultTimeZone, onSaved }: { mailbox: Mailbox; zones: string[]; defaultTimeZone: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const initialDays = mailbox.workingHours ? Object.entries(mailbox.workingHours.days).filter(([, w]) => w.length > 0).map(([d]) => d) : ["1", "2", "3", "4", "5"];
  const savedHours = mailbox.workingHours ? "custom" : "organization";
  // A mailbox without its own hours follows the organization's zone, so saving keeps it unset until someone picks Custom.
  const [hours, setHours] = useState<"organization" | "custom">(savedHours);
  const [days, setDays] = useState<string[]>(initialDays);
  const savedTimeZone = mailbox.workingHours?.timeZone ?? defaultTimeZone;
  const [timeZone, setTimeZone] = useState(savedTimeZone);
  const firstWindow = mailbox.workingHours ? Object.values(mailbox.workingHours.days).find((w) => w.length > 0)?.[0] : undefined;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const window = { start: String(data.get("start")), end: String(data.get("end")) };
    setPending(true);
    setError(null);
    const result = await callApi(`/api/mailboxes/${mailbox.id}`, "PATCH", {
      displayName: String(data.get("displayName") ?? "").trim() || null,
      dailySendLimit: Number(data.get("dailySendLimit")),
      signatureHtml: String(data.get("signatureHtml") ?? "").trim() || null,
      workingHours: hours === "organization" ? null : { timeZone, days: Object.fromEntries(days.map((d) => [d, [window]])) },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Mailbox settings saved.");
    setOpen(false);
    onSaved();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reopening starts from what is saved, not from an abandoned edit.
        if (next) {
          setHours(savedHours);
          setDays(initialDays);
          setTimeZone(savedTimeZone);
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Edit limits and hours</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{mailbox.emailAddress}</DialogTitle>
            <DialogDescription>Limits and hours apply to this mailbox only.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="s-name">Sender name</Label>
            <Input id="s-name" name="displayName" defaultValue={mailbox.displayName ?? ""} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-limit">Emails per day (1 to 200)</Label>
            <Input id="s-limit" name="dailySendLimit" type="number" min={1} max={200} defaultValue={mailbox.dailySendLimit} className="w-28" required />
          </div>
          <fieldset className="grid gap-2">
            <legend className="pb-2 text-sm font-medium">Sending hours</legend>
            <RadioGroup value={hours} onValueChange={(v) => setHours(v as "organization" | "custom")}>
              <label className="flex items-start gap-2 text-sm">
                <RadioGroupItem value="organization" className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span>Organization hours</span>
                  <span className="text-muted-foreground">Monday to Friday, 09:00 to 18:00, {defaultTimeZone}. Follows the organization&apos;s time zone when it changes.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <RadioGroupItem value="custom" className="mt-0.5" />
                <span>Custom hours for this mailbox</span>
              </label>
            </RadioGroup>
          </fieldset>
          {hours === "custom" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="s-tz">Time zone</Label>
                <TimeZoneSelect id="s-tz" zones={zones.includes(timeZone) ? zones : [timeZone, ...zones]} value={timeZone} onValueChange={setTimeZone} />
              </div>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Send on</legend>
                <div className="flex flex-wrap gap-3">
                  {DAYS.map((d) => (
                    <label key={d.key} className="flex items-center gap-1.5 text-sm">
                      <Checkbox checked={days.includes(d.key)} onCheckedChange={(checked) => setDays((all) => (checked ? [...all, d.key] : all.filter((x) => x !== d.key)))} />
                      {d.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="s-start">From</Label>
                  <Input id="s-start" name="start" type="time" defaultValue={firstWindow?.start ?? "09:00"} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="s-end">Until</Label>
                  <Input id="s-end" name="end" type="time" defaultValue={firstWindow?.end ?? "18:00"} required />
                </div>
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="s-sig">Signature</Label>
            <Textarea id="s-sig" name="signatureHtml" rows={4} defaultValue={mailbox.signatureHtml ?? ""} placeholder={"Ada Lovelace\nAcme"} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface TestSendResult {
  status: "sent" | "failed" | "unknown" | "blocked" | "rate_limited";
  message: string;
}

/** Sends one test email through the normal send claim, and shows the outcome in words. */
function TestSendDialog({ mailbox, open, onOpenChange }: { mailbox: Mailbox; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <TestSendForm mailbox={mailbox} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted with the dialog content, so every opening starts without the last error or result. */
function TestSendForm({ mailbox }: { mailbox: Mailbox }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestSendResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setResult(null);
    const response = await callApi<TestSendResult>(`/api/mailboxes/${mailbox.id}/send-test`, "POST", { to: String(data.get("to") ?? "").trim() });
    setPending(false);
    if (!response.ok) setError(response.error);
    else setResult(response.data);
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Send a test email from {mailbox.emailAddress}</DialogTitle>
        <DialogDescription>
          The test goes through the same checks as a campaign email. A mailbox sends 3 test emails per hour, and test emails do not use the daily campaign limit.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={`test-to-${mailbox.id}`}>Send to</Label>
        <Input id={`test-to-${mailbox.id}`} name="to" type="email" required placeholder="you@example.com" />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        // A delivered test is the normal outcome, so it reads in the foreground with a check; anything else is an error.
        <p role={result.status === "sent" ? "status" : "alert"} data-testid="test-send-result" className={cn("flex items-start gap-2 text-sm", result.status !== "sent" && "text-destructive")}>
          {result.status === "sent" && <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          {result.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send test"}
        </Button>
      </DialogFooter>
    </form>
  );
}
