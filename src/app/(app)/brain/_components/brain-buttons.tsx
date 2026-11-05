"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { isRestoreBlocked } from "@/contexts/brain/domain/brain-item";
import { BrainItemDialog, type BrainDialogItem } from "./brain-item-dialog";

export function AddBrainItemButton({ hasCompanyProfile, variant = "default" }: { hasCompanyProfile: boolean; variant?: "default" | "outline" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        Add to Brain
      </Button>
      <BrainItemDialog open={open} onOpenChange={setOpen} item={null} hasCompanyProfile={hasCompanyProfile} />
    </>
  );
}

/** Edit and Archive or Restore on an item's page. Only one company profile can be active, so another active one holds Restore. */
export function BrainItemActions({ item, active, hasCompanyProfile }: { item: BrainDialogItem; active: boolean; hasCompanyProfile: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction();

  const toggle = () =>
    run(item.id, async () => {
      setError(null);
      const result = await runApiAction(callApi(`/api/brain/${item.id}`, "PATCH", { active: !active }), { refresh: () => router.refresh() });
      if (!result.ok) return setError(result.error);
      toast.success(active ? `${item.title} archived.` : `${item.title} restored.`);
    });

  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button variant="outline" onClick={() => setEditing(true)}>
        {item.legacyText !== null ? "Sort" : "Edit"}
      </Button>
      <Button variant="ghost" disabled={isBusy(item.id) || isRestoreBlocked({ kind: item.kind, active }, hasCompanyProfile)} onClick={() => void toggle()}>
        {isBusy(item.id) ? (active ? "Archiving…" : "Restoring…") : active ? "Archive" : "Restore"}
      </Button>
      <BrainItemDialog open={editing} onOpenChange={setEditing} item={item} hasCompanyProfile={hasCompanyProfile} />
    </>
  );
}
