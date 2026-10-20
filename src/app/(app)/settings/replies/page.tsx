import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCrmTaxonomy } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { cn } from "@/lib/utils";
import { toActor } from "@/shared/api";
import { SettingsSection } from "../settings-section";
import { InstructionsPanel } from "./instructions-panel";
import { TaxonomyPanel } from "./taxonomy-panel";
import { ThresholdsForm } from "./thresholds-form";

export const metadata: Metadata = { title: "Replies" };

export default function ReplySettingsPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-3xl" />}>
        <Settings />
      </Suspense>
    </div>
  );
}

async function Settings() {
  await connection();
  const { subcategories, settings } = await getCrmTaxonomy(crmDeps(), toActor(await requireOrgContext()));
  return (
    <>
      <SettingsSection title="Knowledge" description="Pasted text the AI draws on when it writes replies. It has its own page.">
        <div>
          <Link href="/settings/knowledge" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Open knowledge
          </Link>
        </div>
      </SettingsSection>
      <ThresholdsForm settings={{ autoApplyConfidence: settings.autoApplyConfidence, reviewOther: settings.reviewOther, customerRequiresReview: settings.customerRequiresReview }} />
      <TaxonomyPanel subcategories={subcategories} />
      <InstructionsPanel draft={settings.draftInstructions} classification={settings.classificationInstructions} />
    </>
  );
}
