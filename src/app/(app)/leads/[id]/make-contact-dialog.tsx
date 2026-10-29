"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { runApiAction } from "@/app/_lib/api-action";
import { apiMessage, callApi } from "@/app/_lib/api-client";
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
    // A read sent as POST: nothing changes, so nothing reloads.
    void runApiAction(callApi<ConvertPreview>("/api/leads/convert/preview", "POST", { ids: [personId] }), { expectData: true }).then((result) => {
      if (!live) return;
      if (result.ok) setPreview(result.data);
      else setPreviewError(result.error);
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
    // A success opens the contact page, so nothing reloads this one first.
    const result = await runApiAction(callApi(`/api/leads/${personId}/make-contact`, "POST", {}), { onConflict: { try_again: () => apiMessage("try_again", name) } });
    if (result.ok || result.code === "already_converted") {
      toast.success(`${name} is a contact now.`);
      done();
      return;
    }
    if (result.status === 404) throw new Error(`${name} no longer exists.`);
    // `personal_campaign` carries PERSONAL_CAMPAIGN_MESSAGE; other refusals carry their own sentence.
    throw new Error(result.error);
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
