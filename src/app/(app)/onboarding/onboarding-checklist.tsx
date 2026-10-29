"use client";

import { CheckCircle2Icon, CircleAlertIcon, CircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import type { OnboardingView } from "@/contexts/tenancy/application/onboarding";
import type { StepStatus } from "@/contexts/tenancy/domain/onboarding";
import { HOME } from "@/app/_lib/home";

const ICON: Record<StepStatus, React.ReactNode> = {
  done: <CheckCircle2Icon aria-hidden className="size-5 text-muted-foreground" />,
  // The marks stay grey: lavender belongs to the sidebar's count of open steps, and red to errors. The status word says the rest.
  attention: <CircleAlertIcon aria-hidden className="size-5 text-foreground" />,
  todo: <CircleIcon aria-hidden className="size-5 text-muted-foreground" />,
};

const STATUS_WORD: Record<StepStatus, string> = { done: "Done", attention: "Needs attention", todo: "To do" };

export function OnboardingChecklist({ view }: { view: OnboardingView }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const next = view.steps.find((step) => step.id === view.nextStepId);

  async function hide() {
    orThrow(await runApiAction(callApi("/api/onboarding/dismiss", "POST")));
    router.push(HOME);
    router.refresh();
  }

  return (
    <div className="stack-group max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {view.complete ? `All ${view.requiredTotal} required steps done` : `${view.requiredDone} of ${view.requiredTotal} required steps done`}
        </p>
        {next && (
          <Link href={next.href} className={buttonVariants({ touch: true })}>
            Next: {next.title}
          </Link>
        )}
      </div>
      {/* One ruled list, no box. Next above is the next step's one action, so its row holds none; the other open steps keep a quiet ghost link. */}
      <ol className="divide-y">
        {view.steps.map((step) => {
          const isNext = step.id === view.nextStepId;
          return (
            <li key={step.id} aria-current={isNext ? "step" : undefined} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
              <span className="mt-0.5 shrink-0">{ICON[step.status]}</span>
              {/* Below sm the action sits under the text, so the description keeps the row's width. */}
              <div className="flex min-w-0 flex-1 flex-col items-start gap-3 sm:flex-row">
                <div className="stack-field min-w-0 flex-1">
                  <h2 className={cn("heading-item flex flex-wrap items-center gap-2", step.status === "done" && "text-muted-foreground")}>
                    {step.title}
                    {step.optional && <Badge variant="outline">Optional</Badge>}
                    <span className="text-xs font-normal text-muted-foreground">{STATUS_WORD[step.status]}</span>
                  </h2>
                  {step.status !== "done" && <p className="text-sm text-muted-foreground">{step.description}</p>}
                  {step.detail && <p className="text-sm">{step.detail}</p>}
                </div>
                {step.status !== "done" && !isNext && (
                  <Button variant="ghost" size="sm" touch nativeButton={false} render={<Link href={step.href} />} className="shrink-0">
                    {step.action}
                  </Button>
                )}
              </div>
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
        description="The step count and highlight leave the sidebar for every owner and admin, and you go on to Actions. The Setup guide link and this page stay."
        confirmLabel="Hide setup guide"
        pendingLabel="Hiding…"
        onConfirm={hide}
      />
    </div>
  );
}
