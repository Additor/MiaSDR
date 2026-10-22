"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { MoveDealStageDialog, STALE_MOVE, moveDealStage } from "../_components/move-deal-stage-dialog";
import type { DealStageList } from "../_components/deal-form";
import type { CardData } from "./board-column";

/**
 * A card a drag moved since the board loaded: the card as it is now (its new version once the server took the move),
 * the stage the server last put it in (`origin`) and the stage it sits in now. `pending` while the move is on its way.
 */
export interface MovedCard {
  card: CardData;
  origin: string;
  stage: string;
  pending: boolean;
  /** The board a finished move applies to. A board the server sent after it already includes the move. */
  board: string;
}

/** What one stage needs from the moves, worked out once per change for every column. */
export interface StageMoves {
  /** Cards that sit in this stage now, by id: they replace the column's own copy, version included. */
  here: ReadonlyMap<string, MovedCard>;
  /** Cards that moved in from another stage and cards that moved out, for the count and the totals. */
  arrived: readonly CardData[];
  departed: readonly CardData[];
}

const NO_MOVES: StageMoves = { here: new Map(), arrived: [], departed: [] };

export interface DropTarget {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
}

interface BoardActions {
  startDrag: (card: CardData, from: string) => void;
  /** Ends the drag. With an id, ends it only when that card is the one in hand, such as a card leaving the page. */
  endDrag: (cardId?: string) => void;
  /** Drops the dragged card on a stage. Won and Lost ask first, as Mark won and Mark lost do; an open stage moves at once. */
  drop: (to: DropTarget) => void;
}

interface BoardState {
  /** The card being dragged, with the stage it sits in. */
  dragging: { card: CardData; from: string } | null;
  movesFor: (stageId: string | null) => StageMoves;
  /** The stage a dragged card sits in now, or undefined for a card no drag moved. */
  stageOf: (cardId: string) => string | undefined;
}

// Two contexts: the actions never change, so a card that only starts and ends drags does not render again on every move.
const Actions = createContext<BoardActions | null>(null);
const State = createContext<BoardState | null>(null);

export function useBoardActions(): BoardActions {
  const value = useContext(Actions);
  if (!value) throw new Error("useBoardActions needs a BoardMovesProvider");
  return value;
}

export function useBoardState(): BoardState {
  const value = useContext(State);
  if (!value) throw new Error("useBoardState needs a BoardMovesProvider");
  return value;
}

/** The deal fields a move answers with, read from the `GET /api/deals/[id]` shape. */
function movedFields(deal: unknown): { version: number; stageChangedAt: string } | null {
  const d = deal as { version?: unknown; stageChangedAt?: unknown } | null;
  return typeof d?.version === "number" && typeof d.stageChangedAt === "string" ? { version: d.version, stageChangedAt: d.stageChangedAt } : null;
}

/**
 * Drag and drop for the deal board, and the one record of where each dragged card sits. Columns keep the cards the
 * server sent them and read the moves from here, so a card has one stage and one version on the whole board.
 *
 * A card dropped on an open stage moves on screen at once and the move goes to the server with the card's version. The
 * card then takes the version and stage date the server answers with, so it moves again without a reload, and cards
 * loaded with "N more" stay. A refusal puts the card back where it was before that drop, says why and reloads the board.
 * Won and Lost open the move dialog on that stage. Each card's Move stage button stays the way to move from the keyboard
 * or a touch screen.
 *
 * `boardKey` names the board the server last sent. A finished move counts only on the board it finished on: a board the
 * server sends later already includes it.
 */
export function BoardMovesProvider({ stages, boardKey, children }: { stages: DealStageList; boardKey: string; children: ReactNode }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<BoardState["dragging"]>(null);
  const draggingRef = useRef<BoardState["dragging"]>(null);
  const [moved, setMovedState] = useState<Map<string, MovedCard>>(new Map());
  // The moves as of the last change, for the async move to read what was there before its own drop.
  const movedRef = useRef(moved);
  const setMoved = useCallback((change: (current: Map<string, MovedCard>) => Map<string, MovedCard>) => {
    movedRef.current = change(movedRef.current);
    setMovedState(movedRef.current);
  }, []);
  const [asking, setAsking] = useState<{ card: CardData; from: string; to: string } | null>(null);
  const boardRef = useRef(boardKey);
  useEffect(() => {
    boardRef.current = boardKey;
  }, [boardKey]);

  /** The move of a card that still counts: in flight, or finished on the board shown now. */
  const live = useCallback((m: MovedCard | undefined) => (m && (m.pending || m.board === boardRef.current) ? m : undefined), []);

  const setDrag = useCallback((next: BoardState["dragging"]) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);

  const send = useCallback(
    async (card: CardData, from: string, to: DropTarget) => {
      const before = live(movedRef.current.get(card.id));
      const origin = before?.origin ?? from;
      setMoved((current) => new Map([...current].filter(([, m]) => live(m))).set(card.id, { card, origin, stage: to.id, pending: true, board: boardRef.current }));
      const result = await moveDealStage(card.id, to.id, card.version);
      const fields = result.ok ? movedFields(result.deal) : null;
      if (result.ok && fields) {
        setMoved((current) => new Map(current).set(card.id, { card: { ...card, ...fields }, origin, stage: to.id, pending: false, board: boardRef.current }));
        toast.success(`Moved ${card.title} to ${to.name}.`);
        return;
      }
      if (result.ok) {
        // The move went through but its answer lacks the new version: the board reloads to read it.
        toast.success(`Moved ${card.title} to ${to.name}.`);
      } else {
        // Back to where the card was before this drop, an earlier finished move included.
        setMoved((current) => {
          const next = new Map(current);
          if (before) next.set(card.id, before);
          else next.delete(card.id);
          return next;
        });
        toast.error("staleVersion" in result ? STALE_MOVE : result.error);
      }
      router.refresh();
    },
    [router, setMoved, live],
  );

  const actions = useMemo<BoardActions>(
    () => ({
      startDrag: (card, from) => setDrag({ card, from }),
      endDrag: (cardId) => {
        if (cardId === undefined || draggingRef.current?.card.id === cardId) setDrag(null);
      },
      drop: (to) => {
        const current = draggingRef.current;
        setDrag(null);
        if (!current || current.from === to.id) return;
        if (to.kind !== "open") return setAsking({ card: current.card, from: current.from, to: to.id });
        void send(current.card, current.from, to);
      },
    }),
    [send, setDrag],
  );

  // One pass over the moves for every stage, so a column looks its part up instead of scanning the moves.
  const byStage = useMemo(() => {
    const index = new Map<string, { here: Map<string, MovedCard>; arrived: CardData[]; departed: CardData[] }>();
    const stages = new Map<string, string>();
    const slot = (id: string) => {
      let s = index.get(id);
      if (!s) index.set(id, (s = { here: new Map(), arrived: [], departed: [] }));
      return s;
    };
    for (const m of moved.values()) {
      if (!m.pending && m.board !== boardKey) continue;
      stages.set(m.card.id, m.stage);
      slot(m.stage).here.set(m.card.id, m);
      if (m.origin === m.stage) continue;
      slot(m.stage).arrived.push(m.card);
      slot(m.origin).departed.push(m.card);
    }
    return { index, stages };
  }, [moved, boardKey]);

  const state = useMemo<BoardState>(
    () => ({ dragging, movesFor: (id) => (id ? (byStage.index.get(id) ?? NO_MOVES) : NO_MOVES), stageOf: (cardId) => byStage.stages.get(cardId) }),
    [dragging, byStage],
  );

  return (
    <Actions.Provider value={actions}>
      <State.Provider value={state}>
        {children}
        {asking && (
          <MoveDealStageDialog
            open
            onOpenChange={(open) => !open && setAsking(null)}
            deal={{ id: asking.card.id, title: asking.card.title, version: asking.card.version, stageId: asking.from }}
            stages={stages}
            targetStageId={asking.to}
          />
        )}
      </State.Provider>
    </Actions.Provider>
  );
}
