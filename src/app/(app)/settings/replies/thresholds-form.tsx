"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

interface Settings {
  autoApplyConfidence: number;
  reviewOther: boolean;
  customerRequiresReview: boolean;
}

export function ThresholdsForm({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [percent, setPercent] = useState(String(Math.round(settings.autoApplyConfidence * 1000) / 10));
  const [reviewOther, setReviewOther] = useState(settings.reviewOther);
  const [customer, setCustomer] = useState(settings.customerRequiresReview);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const value = Number(percent);
    const result = await callApi("/api/settings/replies", "PATCH", { autoApplyConfidence: value / 100, reviewOther, customerRequiresReview: customer });
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success("Auto-apply rules saved.");
    router.refresh();
  }

  return (
    <SettingsSection title="Auto-apply rules" description="The AI applies a classification alone only when none of these rules hold it back. A held suggestion waits for a person. Replies are never sent without approval.">
      <form onSubmit={save} className="stack-group">
        <div className="stack-field">
          <Label htmlFor="threshold">Auto-apply at or above (percent confidence)</Label>
          <Input id="threshold" type="number" min={0} max={100} step={0.1} value={percent} onChange={(e) => setPercent(e.target.value)} className="w-32" required />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="review-other" checked={reviewOther} onCheckedChange={(c) => setReviewOther(c === true)} />
          <Label htmlFor="review-other">Always review the category Other</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="review-customer" checked={customer} onCheckedChange={(c) => setCustomer(c === true)} />
          <Label htmlFor="review-customer">Always review a move to Existing customer</Label>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save rules"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
