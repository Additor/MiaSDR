"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { callApi } from "@/app/_lib/api-client";
import { permanenceText, singleEffectsText, type ConvertPreview } from "../../crm/_components/deal-effects";

/**
 * Make contact without a deal, from the lead page's More menu: the lead becomes a contact without a deal. The dialog says first what the conversion
 * stops (`POST /api/leads/convert/preview`) and that it cannot be undone, then calls `POST /api/leads/[id]/make-contact`. An
 * `already_converted` answer counts as done and opens the contact page.
 */
export function MakeContactDialog({ personId, name, open, onOpenChange: setOpen }: { personId: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [preview, setPreview] = useState<ConvertPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  // Each open reads the effects again.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPreview(null);
      setPreviewError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    void callApi<ConvertPreview>("/api/leads/convert/preview", "POST", { ids: [personId] }).then((result) => {
      if (!live) return;
      if (result.ok && result.data) setPreview(result.data);
      else setPreviewError(result.error ?? "Could not check what this changes. Try again.");
    });
    return () => {
      live = false;
    };
  }, [open, personId]);

  const done = () => {
    router.replace(`/crm/contacts/${personId}`);
    router.refresh();
  };

  async function make() {
    const response = await fetch(`/api/leads/${personId}/make-contact`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (!response) throw new Error("Could not reach the server.");
    const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    if (response.ok || body?.code === "already_converted") {
      toast.success(`${name} is a contact now.`);
      done();
      return;
    }
    if (response.status === 404) throw new Error(`${name} no longer exists.`);
    if (body?.code === "try_again") throw new Error(`MiaSDR is saving another change to ${name}. Try again in a moment.`);
    // `personal_campaign` carries PERSONAL_CAMPAIGN_MESSAGE; other refusals carry their own sentence.
    throw new Error(body?.error ?? "Could not make this lead a contact. Try again.");
  }

  let description: string;
  if (previewError) description = previewError;
  else if (!preview) description = "Checking what this changes…";
  else description = `${singleEffectsText(name, preview)} ${permanenceText(name, { withDeal: false })}`;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={`Make ${name} a contact?`}
      description={description}
      confirmLabel="Make contact"
      pendingLabel="Making contact…"
      confirmDisabled={preview === null}
      className="sm:max-w-md"
      onConfirm={make}
    />
  );
}
