"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { ProviderManager } from "@/app/(app)/tables/_components/provider-manager";
import { useProviders } from "@/app/(app)/tables/_lib/data/providers";
import { SettingsSection } from "../settings-section";

/** The enrichment provider keys, the same manager a table's Enrich dialog opens. Keys live here with the AI key. */
export function EnrichmentProviders() {
  const { catalog, providers, loading, error, refresh } = useProviders();
  return (
    <SettingsSection title="Enrichment providers" description="Tables call these providers to find and verify emails and to enrich people and companies. A table's Enrich dialog opens the same list.">
      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <ProviderManager catalog={catalog} providers={providers} onChanged={refresh} />
      )}
    </SettingsSection>
  );
}
