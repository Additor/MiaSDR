import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { toActor } from "@/app/_lib/api";
import { brainHasActiveCompanyProfile, getBrainItem } from "@/contexts/brain/application/brain-items";
import { brainFieldRows } from "@/contexts/brain/domain/brain-fields";
import { isRestoreBlocked } from "@/contexts/brain/domain/brain-item";
import { BRAIN_KIND_LABELS, isBrainItemKind } from "@/contexts/brain/domain/brain-kinds";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { isPromptKind } from "@/contexts/conversations/ai/domain/knowledge";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { miaUnavailable } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";
import { NotFoundError } from "@/shared/errors";
import { BrainItemActions } from "../_components/brain-buttons";
import { SortWithMiaButton } from "../_components/mia-controls";

export const metadata: Metadata = { title: "Brain" };

export default function BrainItemPage({ params }: PageProps<"/brain/[id]">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Item" titleAs="p" back={{ href: "/brain", label: "Brain" }} />
          <div className="page">
            <PageSkeleton shape="form" />
          </div>
        </>
      }
    >
      <BrainItem params={params} />
    </Suspense>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="stack-field">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

async function BrainItem({ params }: { params: PageProps<"/brain/[id]">["params"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const { id } = await params;
  const [item, hasCompanyProfile, unavailable] = await Promise.all([
    getBrainItem(brainStore, actor, id).catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }),
    brainHasActiveCompanyProfile(brainStore, actor),
    miaUnavailable(miaDeps(), actor),
  ]);
  const rows = item.structuredData && isBrainItemKind(item.kind) ? brainFieldRows(item.kind, item.structuredData) : [];
  const dialogItem = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    description: item.description,
    tags: item.tags,
    alwaysInclude: item.alwaysInclude,
    revision: item.revision,
    legacyText: item.legacy ? item.content : null,
    structuredData: item.structuredData,
  };

  return (
    <>
      <PageHeader
        title={item.title}
        titleAs="p"
        back={{ href: "/brain", label: "Brain" }}
        actions={
          <>
            {item.legacy && item.active && <SortWithMiaButton itemId={item.id} unavailable={unavailable} />}
            <BrainItemActions item={dialogItem} active={item.active} hasCompanyProfile={hasCompanyProfile} />
          </>
        }
      />
      <div className="page stack-section max-w-3xl">
        <div className="stack-field">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="heading-section">{item.title}</h1>
            {item.legacy && <Badge variant="secondary">Needs sorting</Badge>}
            {!item.active && <Badge variant="secondary">Archived</Badge>}
            {item.alwaysInclude && <Badge variant="secondary">Always included</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {BRAIN_KIND_LABELS[item.kind]} · Version {item.version} · Updated <Time value={item.updatedAt} />
          </p>
          {item.description && <p className="text-sm">{item.description}</p>}
          {isRestoreBlocked(item, hasCompanyProfile) && <p className="text-sm text-muted-foreground">Another company profile is active. Archive it before you restore this one.</p>}
          {!isPromptKind(item.kind) && <p className="text-sm text-muted-foreground">AI drafts don&apos;t use this kind yet.</p>}
        </div>

        <dl data-testid="brain-item-fields" className="stack-group">
          {item.legacy ? <Row label="Pasted text">{item.content}</Row> : rows.map((row) => <Row key={row.key} label={row.label}>{row.value}</Row>)}
          {item.tags.length > 0 && <Row label="Tags">{item.tags.join(", ")}</Row>}
        </dl>
      </div>
    </>
  );
}
