"use client";

import { memo, useEffect, useMemo, useState, type DragEvent } from "react";
import { cn } from "@/lib/utils";
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
import { useBoardActions, useBoardState } from "./board-moves";
import { daysInStage, formatAmount, formatTotals, ownerText, shiftTotals } from "./deal-format";

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

/**
 * `from` is the board with its filters, so the deal page goes back to the same board. A card in a real stage drags to
 * another column; `dragged` marks the card in hand and `moving` a card whose move the server has not confirmed yet.
 * The card renders again only when its own props change, so a drag does not redraw the whole board.
 */
const DealCard = memo(function DealCard({ card, stageId, stages, nowMs, from, dragged, moving }: { card: CardData; stageId: string; stages: DealStageList; nowMs: number; from: string; dragged: boolean; moving: boolean }) {
  const { startDrag, endDrag } = useBoardActions();
  // A card that leaves the page mid-drag never gets its dragend, so it ends its own drag on the way out.
  useEffect(() => () => endDrag(card.id), [card.id, endDrag]);
  const contact = card.personName ?? "Unnamed contact";
  const facts = [card.amountMinor !== null && card.currency ? formatAmount(card.amountMinor, card.currency) : null, ownerText(card.owner)].filter(Boolean);
  const draggable = stageId !== "" && !moving;

  function onDragStart(event: DragEvent<HTMLDivElement>) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.title);
    // The drag starts on the card's stretched link; the whole card is what moves.
    const box = event.currentTarget.getBoundingClientRect();
    event.dataTransfer.setDragImage(event.currentTarget, event.clientX - box.left, event.clientY - box.top);
    startDrag(card, stageId);
  }

  return (
    <Card
      size="sm"
      className={cn(rowLinkClasses, draggable && "active:cursor-grabbing", dragged && "opacity-50", moving && "opacity-70")}
      data-testid="deal-card"
      aria-busy={moving || undefined}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={() => endDrag()}
    >
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
            <MoveDealStageButton deal={{ id: card.id, title: card.title, version: card.version, stageId }} stages={stages} size="xs" disabled={moving} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

/**
 * One stage of the board. The server renders the first 25 cards; "N more" loads the next page of this stage from
 * `GET /api/deals` and appends it inside the column.
 */
export function BoardColumn({ column, stages, nowMs, query, closedWindow }: { column: ColumnData; stages: DealStageList; nowMs: number; query: BoardQueryParams; closedWindow: boolean }) {
  const { drop } = useBoardActions();
  const { dragging, movesFor, stageOf } = useBoardState();
  const [over, setOver] = useState(false);
  const [cards, setCards] = useState(column.cards);
  const [cursor, setCursor] = useState(column.nextCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "N more" pages through the server's stage, so its count stays the server's.
  const remaining = Math.max(0, column.total - cards.length);
  // The drag moves for this stage: a card that moved in replaces the column's copy or shows first, one that moved out
  // hides, and the count and totals follow both, whatever "N more" has loaded.
  const moves = movesFor(column.id);
  const loaded = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const arriving = [...moves.here.values()].filter((m) => !loaded.has(m.card.id));
  const shown = cards.filter((c) => (stageOf(c.id) ?? column.id) === column.id).map((c) => ({ card: moves.here.get(c.id)?.card ?? c, pending: moves.here.get(c.id)?.pending ?? false }));
  const total = column.total - moves.departed.length + moves.arrived.length;
  const totals = formatTotals(shiftTotals(column.amounts, moves.departed, moves.arrived));
  const accepts = dragging !== null && column.id !== null && dragging.from !== column.id;
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
    <section
      className={cn("-m-1 grid w-74 shrink-0 content-start gap-2 rounded-lg p-1 transition-colors", accepts && over && "bg-primary/5 ring-1 ring-primary/30")}
      aria-label={column.name}
      data-testid="board-column"
      onDragOver={(e) => {
        if (!accepts) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (accepts && column.id) drop({ id: column.id, name: column.name, kind: column.kind });
      }}
    >
      <header className="grid gap-0.5 px-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="truncate text-sm font-semibold">{column.name}</h2>
          <span className="text-xs text-muted-foreground tabular-nums" aria-label={`${total} deal${total === 1 ? "" : "s"}`}>
            {total}
          </span>
        </div>
        {(totals || (closedWindow && column.kind !== "open")) && (
          <p className="truncate text-xs text-muted-foreground tabular-nums" title={totals ?? undefined}>
            {[closedWindow && column.kind !== "open" ? "Last 30 days" : null, totals].filter(Boolean).join(", ")}
          </p>
        )}
      </header>
      {shown.length + arriving.length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{accepts ? "Drop a deal here" : "No deals in this stage"}</p>}
      {arriving.map((m) => (
        <DealCard key={m.card.id} card={m.card} stageId={column.id ?? ""} stages={stages} nowMs={nowMs} from={from} dragged={dragging?.card.id === m.card.id} moving={m.pending} />
      ))}
      {shown.map(({ card, pending }) => (
        <DealCard key={card.id} card={card} stageId={column.id ?? ""} stages={stages} nowMs={nowMs} from={from} dragged={dragging?.card.id === card.id} moving={pending} />
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
