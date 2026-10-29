"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shell/error-state";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { ProviderManager } from "@/app/(app)/tables/_components/provider-manager";
import { useProviders } from "@/app/(app)/tables/_lib/data/providers";
import { SettingsSection } from "../settings-section";

/** The enrichment provider keys, the same manager a table's Enrich dialog opens. Keys live here with the AI key. */
export function EnrichmentProviders() {
  const { catalog, providers, loading, error, refresh } = useProviders();
  return (
    <SettingsSection title="Enrichment providers" description="Tables call these providers to find and verify emails and to enrich people and companies. A table's Enrich dialog opens the same list.">
      {loading ? (
        <ListSkeleton rows={3} toolbar={false} label="Loading providers" />
      ) : error ? (
        <ErrorState
          inline
          title="The providers did not load"
          reason={error}
          action={
            <Button variant="outline" size="sm" touch onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      ) : (
        <ProviderManager catalog={catalog} providers={providers} onChanged={refresh} />
      )}
    </SettingsSection>
  );
}
