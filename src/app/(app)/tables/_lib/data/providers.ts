"use client";

import { useCallback, useEffect, useState } from "react";
import { gridRequest } from "./client";

export interface ActionInput {
  key: string;
  name: string;
  type: string;
  required: boolean;
}
export interface ActionOutput {
  key: string;
  name: string;
  type: string;
}
export interface ActionSpec {
  key: string;
  name: string;
  inputs: ActionInput[];
  outputs: ActionOutput[];
  primaryOutput: string;
  defaultCostCents: number;
}
export interface CatalogEntry {
  key: string;
  name: string;
  description: string;
  status: "available" | "catalog_only";
  adapter: string | null;
  fixedBaseUrl?: string;
  credentialFields: Array<{ key: string; label: string; required: boolean }>;
  actions: ActionSpec[];
}
/** A connected provider. The credential is never part of it, only whether one is stored. */
export interface ProviderView {
  id: string;
  key: string;
  name: string;
  adapter: string;
  baseUrl: string | null;
  defaultCostCents: number;
  rateLimitPerMin: number | null;
  enabled: boolean;
  hasCredential: boolean;
  actions: ActionSpec[];
}

export function useProviders() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await gridRequest<{ catalog: CatalogEntry[]; providers: ProviderView[] }>("/api/grid/providers", "GET");
    if (res.ok && res.data) {
      setCatalog(res.data.catalog);
      setProviders(res.data.providers);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(handle);
  }, [refresh]);

  return { catalog, providers, loading, error, refresh };
}

/** Providers a column can call right now: switched on, with a key when the catalog entry needs one. */
export function usableProviders(providers: ProviderView[], catalog: CatalogEntry[]): ProviderView[] {
  return providers.filter((p) => {
    if (!p.enabled || p.actions.length === 0) return false;
    const entry = catalog.find((c) => c.adapter === p.adapter);
    const needsKey = entry?.credentialFields.some((f) => f.required) ?? false;
    return !needsKey || p.hasCredential;
  });
}

/** Best guess of the column that feeds an action input. */
export function guessColumn(input: { key: string; type: string; name: string }, columns: ReadonlyArray<{ key: string; name: string; type: string }>): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = [norm(input.key), norm(input.name)];
  const exact = columns.find((c) => wanted.includes(norm(c.key)) || wanted.includes(norm(c.name)));
  if (exact) return exact.key;
  if (input.type === "email") return columns.find((c) => c.type === "email")?.key ?? null;
  if (input.type === "url") return columns.find((c) => c.type === "url")?.key ?? null;
  if (input.type === "domain") return columns.find((c) => /domain|website|url/.test(norm(c.key)))?.key ?? null;
  return null;
}
