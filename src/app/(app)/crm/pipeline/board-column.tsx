"use client";

import { useState } from "react";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Board, BoardCard } from "@/contexts/deals/application/deals";
import { callApi } from "@/lib/api-client";
import { MoveDealStageButton } from "../_components/move-deal-stage-dialog";
import type { DealStageList } from "../_components/deal-form";
import type { Json } from "../_components/serialize";
import { dealHref } from "../_components/deal-href";
import { boardHref } from "./board-url";
import { daysInStage, formatAmount, formatTotals, ownerText } from "./deal-format";

export type CardData = Json<BoardCard>;

export interface ColumnData {
  id: string | null;
  name: string;
  kind: "open" | "won" | "lost";
  total: number;
  /** Decimal strings: a column total can pass 2^53 - 1. */
  amounts: Array<{ currency: string; amountMinor: string }>;
  cards: CardData[];
  nextCursor: string | null;
}

/** The board filters, sent again with "N more" so the next cards match the first ones. */
export interface BoardQueryParams {
  owner?: string;
  q?: string;
  showAll: boolean;
}

/** `from` is the board with its filters, so the deal page goes back to the same board. */
function DealCard({ card, stageId, stages, nowMs, from }: { card: CardData; stageId: string; stages: DealStageList; nowMs: number; from: string }) {
  const contact = card.personName ?? "Unnamed contact";
  const facts = [card.amountMinor !== null && card.currency ? formatAmount(card.amountMinor, card.currency) : null, ownerText(card.owner)].filter(Boolean);
  return (
    <Card size="sm" className={rowLinkClasses} data-testid="deal-card">
      <CardHeader>
        <CardTitle className="text-sm leading-snug break-words">
          <RowLink href={dealHref(card.id, from)}>{card.title}</RowLink>
        </CardTitle>
        <p className="truncate text-xs text-muted-foreground">{card.companyName ? `${contact}, ${card.companyName}` : contact}</p>
      </CardHeader>
      <CardContent className="grid gap-2 text-xs">
        <p className="truncate tabular-nums">{facts.join(", ")}</p>
        {card.source && <p className="truncate text-muted-foreground">From {card.source.campaignName}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground tabular-nums" title="Time in this stage">
            {daysInStage(card.stageChangedAt, nowMs)}
          </span>
          <div className="relative z-10">
            <MoveDealStageButton deal={{ id: card.id, title: card.title, version: card.version, stageId }} stages={stages} size="xs" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One stage of the board. The server renders the first 25 cards; "N more" loads the next page of this stage from
 * `GET /api/deals` and appends it inside the column.
 */
export function BoardColumn({ column, stages, nowMs, query, closedWindow }: { column: ColumnData; stages: DealStageList; nowMs: number; query: BoardQueryParams; closedWindow: boolean }) {
  const [cards, setCards] = useState(column.cards);
  const [cursor, setCursor] = useState(column.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totals = formatTotals(column.amounts);
  const remaining = Math.max(0, column.total - cards.length);
  const from = boardHref(query);

  async function more() {
    if (!column.id || !cursor) return;
    setPending(true);
    setError(null);
    const params = new URLSearchParams({ stage: column.id, cursor });
    if (query.owner) params.set("owner", query.owner);
    if (query.q) params.set("q", query.q);
    if (query.showAll) params.set("showAll", "1");
    const result = await callApi<Json<Board>>(`/api/deals?${params}`, "GET");
    setPending(false);
    const next = result.data?.columns[0];
    if (!result.ok || !next) return setError(result.error ?? "Could not load more deals. Try again.");
    const seen = new Set(cards.map((c) => c.id));
    setCards([...cards, ...next.cards.filter((c) => !seen.has(c.id))]);
    setCursor(next.nextCursor);
  }

  return (
    <section className="grid w-72 shrink-0 content-start gap-2" aria-label={column.name}>
      <header className="grid gap-0.5 px-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="truncate text-sm font-semibold">{column.name}</h2>
          <span className="text-xs text-muted-foreground tabular-nums" aria-label={`${column.total} deal${column.total === 1 ? "" : "s"}`}>
            {column.total}
          </span>
        </div>
        {(totals || (closedWindow && column.kind !== "open")) && (
          <p className="truncate text-xs text-muted-foreground tabular-nums" title={totals ?? undefined}>
            {[closedWindow && column.kind !== "open" ? "Last 30 days" : null, totals].filter(Boolean).join(", ")}
          </p>
        )}
      </header>
      {cards.length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No deals in this stage</p>}
      {cards.map((card) => (
        <DealCard key={card.id} card={card} stageId={column.id ?? ""} stages={stages} nowMs={nowMs} from={from} />
      ))}
      {remaining > 0 && cursor && (
        <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={more} disabled={pending}>
          {pending ? "Loading…" : `${remaining} more`}
        </Button>
      )}
      {error && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
