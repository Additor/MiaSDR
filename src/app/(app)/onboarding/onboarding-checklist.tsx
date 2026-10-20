"use client";

import { CheckCircle2Icon, CircleAlertIcon, CircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OnboardingView } from "@/contexts/tenancy/application/onboarding";
import type { StepStatus } from "@/contexts/tenancy/domain/onboarding";

const ICON: Record<StepStatus, React.ReactNode> = {
  done: <CheckCircle2Icon aria-hidden className="size-5 text-primary" />,
  // A step that needs attention waits on an admin: the lavender of the sidebar counts, not the error red.
  attention: <CircleAlertIcon aria-hidden className="size-5 text-sidebar-count" />,
  todo: <CircleIcon aria-hidden className="size-5 text-muted-foreground" />,
};

const STATUS_WORD: Record<StepStatus, string> = { done: "Done", attention: "Needs attention", todo: "To do" };

export function OnboardingChecklist({ view }: { view: OnboardingView }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const next = view.steps.find((step) => step.id === view.nextStepId);

  async function hide() {
    const response = await fetch("/api/onboarding/dismiss", { method: "POST" });
    if (!response.ok) throw new Error("Could not hide the setup guide. Try again.");
    router.push("/leads");
    router.refresh();
  }

  return (
    <div className="stack-group max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {view.complete ? `All ${view.requiredTotal} required steps done` : `${view.requiredDone} of ${view.requiredTotal} required steps done`}
        </p>
        {next && (
          <Button nativeButton={false} render={<Link href={next.href} />}>
            Next: {next.title}
          </Button>
        )}
      </div>
      {/* One ruled list. The next step carries weight in its title and the filled button; the others stay quiet. */}
      <ol className="divide-y rounded-lg border">
        {view.steps.map((step) => {
          const isNext = step.id === view.nextStepId;
          return (
            <li key={step.id} aria-current={isNext ? "step" : undefined} className="flex flex-wrap items-start gap-3 p-4 sm:flex-nowrap">
              <span className="mt-0.5 shrink-0">{ICON[step.status]}</span>
              <div className="stack-field min-w-0 flex-1">
                <h2 className={cn("flex flex-wrap items-center gap-2 text-sm", isNext ? "font-semibold" : "font-medium", step.status === "done" && "text-muted-foreground")}>
                  {step.title}
                  {step.optional && <Badge variant="outline">Optional</Badge>}
                  <span className="text-xs font-normal text-muted-foreground">{STATUS_WORD[step.status]}</span>
                </h2>
                {step.status !== "done" && <p className="text-sm text-muted-foreground">{step.description}</p>}
                {step.detail && <p className="text-sm">{step.detail}</p>}
              </div>
              {step.status !== "done" && (
                <Button variant={isNext ? "default" : "ghost"} size="sm" nativeButton={false} render={<Link href={step.href} />} className="ml-8 sm:ml-0">
                  {step.action}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3">
        {view.canDismiss && !view.dismissed && (
          <Button variant="ghost" onClick={() => setConfirmOpen(true)}>
            Hide setup guide
          </Button>
        )}
        {view.dismissed && <p className="text-sm text-muted-foreground">The setup guide is hidden for this organization. This page stays available from Setup guide in the sidebar.</p>}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Hide the setup guide for everyone in this organization?"
        description="The step count and highlight leave the sidebar for every owner and admin. The Setup guide link and this page stay. The app has no button to bring the highlight back."
        confirmLabel="Hide setup guide"
        pendingLabel="Hiding..."
        onConfirm={hide}
      />
    </div>
  );
}
