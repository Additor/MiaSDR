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
  /** Input combinations the action can match on, beyond its required inputs. */
  accepts?: string[][];
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

/**
 * The catalog by what a vendor does first: verifiers, finders, enrichers, then everything else (Custom HTTP, the fake
 * provider, catalog-only entries). Catalog order holds inside a group, and empty groups are left out.
 */
export function catalogGroups(catalog: CatalogEntry[]): Array<{ label: string; entries: CatalogEntry[] }> {
  const groups = [
    { label: "Verify email", test: (key: string) => key === "verify-email" },
    { label: "Find work email", test: (key: string) => key === "find-work-email" },
    { label: "Enrich people and companies", test: (key: string) => key === "enrich-person" || key === "enrich-company" },
  ];
  const vendor = (e: CatalogEntry) => e.status === "available" && e.adapter !== "http" && e.adapter !== "fake";
  const out = groups.map((g) => ({ label: g.label, entries: catalog.filter((e) => vendor(e) && g.test(e.actions[0]?.key ?? "")) }));
  const placed = new Set(out.flatMap((g) => g.entries.map((e) => e.key)));
  out.push({ label: "Other", entries: catalog.filter((e) => !placed.has(e.key)) });
  return out.filter((g) => g.entries.length > 0);
}

/** What turning a provider off or disconnecting it touches, as `/api/grid/providers/<id>/impact` returns it. */
export interface ProviderImpact {
  columns: Array<{ tableId: string; tableName: string; columnName: string; waterfall: boolean }>;
  pendingCells: number;
}

/** The confirmation's sentence: what happens to the columns and the waiting cells. */
export function impactText(kind: "off" | "disconnect", impact: ProviderImpact | null): string {
  if (!impact) {
    return kind === "off"
      ? "MiaSDR could not check which columns use it. Their cells would wait until you turn it back on."
      : "MiaSDR could not check which columns use it. The saved key is deleted, and any column that uses it fails until you connect it again.";
  }
  const n = impact.columns.length;
  const cols = `${n} ${n === 1 ? "column uses" : "columns use"} it`;
  const waiting = impact.pendingCells > 0 ? ` ${impact.pendingCells.toLocaleString("en-US")} ${impact.pendingCells === 1 ? "cell is" : "cells are"} waiting to run.` : "";
  if (kind === "off") {
    if (n === 0) return "No column uses it. You can turn it back on at any time.";
    return `${cols}.${waiting} Their cells wait until you turn it back on, without using an attempt; a waterfall asks its other steps meanwhile.`;
  }
  const key = "The saved key is deleted.";
  if (n === 0) return `${key} No column uses it.`;
  return `${key} ${cols}.${waiting} Their cells fail until you connect it again; a waterfall asks its other steps.`;
}

/** One provider's ledger totals, as `/api/grid/providers/usage` returns them. */
export interface ProviderUsage {
  provider: string;
  calls: number;
  hits: number;
  errors: number;
  reused: number;
  credits: number;
  p50LatencyMs: number | null;
}

/** "Last 30 days: 120 calls, 84% found, 3 errors, 12 reused, 60 credits, 420 ms typical". */
export function usageLine(u: ProviderUsage & { days: number }): string {
  const parts = [`${u.calls} ${u.calls === 1 ? "call" : "calls"}`];
  if (u.calls > 0) parts.push(`${Math.round((u.hits / u.calls) * 100)}% found`);
  if (u.errors > 0) parts.push(`${u.errors} ${u.errors === 1 ? "error" : "errors"}`);
  if (u.reused > 0) parts.push(`${u.reused} reused`);
  if (u.credits > 0) parts.push(`${Number(u.credits.toFixed(2))} ${u.credits === 1 ? "credit" : "credits"}`);
  if (u.p50LatencyMs !== null) parts.push(`${u.p50LatencyMs} ms typical`);
  return `Last ${u.days} days: ${parts.join(", ")}`;
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

/** Column names people use for an action input, normalized (lowercase letters and digits). Tried after an exact match. */
const INPUT_ALIASES: Record<string, string[]> = {
  fullName: ["name", "fullname", "contactname", "personname", "leadname"],
  companyDomain: ["domain", "website", "companywebsite", "companyurl", "site"],
  companyName: ["company", "organization", "organisation", "account", "employer"],
  email: ["email", "workemail", "emailaddress", "mail"],
  linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile", "profileurl"],
};

/** Best guess of the column that feeds an action input: its own key or name, then a common alias, then its type. */
export function guessColumn(input: { key: string; type: string; name: string }, columns: ReadonlyArray<{ key: string; name: string; type: string }>): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = [norm(input.key), norm(input.name)];
  const exact = columns.find((c) => wanted.includes(norm(c.key)) || wanted.includes(norm(c.name)));
  if (exact) return exact.key;
  const aliases = INPUT_ALIASES[input.key] ?? [];
  // Visible names only: an import can leave the starter key "name" on a column it renamed "Email". A text input never
  // takes an email or URL column.
  const fits = (c: { type: string }) => input.type !== "text" || (c.type !== "email" && c.type !== "url");
  const alias = aliases.map((a) => columns.find((c) => norm(c.name) === a && fits(c))).find(Boolean);
  if (alias) return alias.key;
  if (input.type === "email") return columns.find((c) => c.type === "email")?.key ?? null;
  if (input.type === "url") return columns.find((c) => c.type === "url")?.key ?? null;
  if (input.type === "domain") return columns.find((c) => /domain|website|url/.test(norm(c.key)))?.key ?? null;
  return null;
}
