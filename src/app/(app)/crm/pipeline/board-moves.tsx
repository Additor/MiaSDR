"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { MoveDealStageDialog, STALE_MOVE, moveDealStage } from "../_components/move-deal-stage-dialog";
import type { DealStageList } from "../_components/deal-form";
import type { CardData } from "./board-column";

/** A card moved by a drag. `done` once the server took it; until then the card shows faded in its new column. */
export interface BoardMove {
  card: CardData;
  from: string;
  to: string;
  done: boolean;
}

export interface DropTarget {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
}

interface BoardActions {
  startDrag: (card: CardData, from: string) => void;
  endDrag: () => void;
  /** Drops the dragged card on a stage. Won and Lost ask first, as Mark won and Mark lost do; an open stage moves at once. */
  drop: (to: DropTarget) => void;
}

interface BoardState {
  /** The card being dragged, with the stage it sits in. */
  dragging: { card: CardData; from: string } | null;
  /** Drag moves since the board last loaded: the source column hides the card and the target column shows it. */
  moves: ReadonlyMap<string, BoardMove>;
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

/**
 * Drag and drop for the deal board. A card dropped on an open stage moves there on screen at once and the move goes to
 * the server with the version the board read. The board does not reload after a move the server took, so cards loaded
 * with "N more" stay; a refusal puts the card back, says why and reloads the board. Won and Lost open the move dialog on
 * that stage. Each card's Move stage button stays the way to move from the keyboard or a touch screen.
 *
 * `boardKey` names the board the server last sent. When it changes, the board shows the server's columns again and the
 * moves it now includes are dropped.
 */
export function BoardMovesProvider({ stages, boardKey, children }: { stages: DealStageList; boardKey: string; children: ReactNode }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<BoardState["dragging"]>(null);
  const [moves, setMoves] = useState<Map<string, BoardMove>>(new Map());
  const [asking, setAsking] = useState<Omit<BoardMove, "done"> | null>(null);
  const [seenKey, setSeenKey] = useState(boardKey);

  if (seenKey !== boardKey) {
    setSeenKey(boardKey);
    setMoves((current) => new Map([...current].filter(([, m]) => !m.done)));
  }

  // The drop handler reads the drag through a ref, so the actions stay one object for the life of the board.
  const draggingRef = useRef(dragging);
  useEffect(() => {
    draggingRef.current = dragging;
  }, [dragging]);

  // A browser sends no mouse events during a drag. The first one after it means the drag ended, even when the dragged
  // card left the page before its dragend could fire.
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(null);
    window.addEventListener("mousemove", end, { once: true });
    return () => window.removeEventListener("mousemove", end);
  }, [dragging]);

  const send = useCallback(
    async (move: Omit<BoardMove, "done">, stageName: string) => {
      setMoves((current) => new Map(current).set(move.card.id, { ...move, done: false }));
      const result = await moveDealStage(move.card.id, move.to, move.card.version);
      if (result.ok) {
        // The new version lets the card move again without a reload.
        const card = { ...move.card, version: result.version ?? move.card.version + 1, stageChangedAt: new Date().toISOString() };
        setMoves((current) => new Map(current).set(move.card.id, { ...move, card, done: true }));
        toast.success(`Moved ${move.card.title} to ${stageName}.`);
        return;
      }
      setMoves((current) => {
        const next = new Map(current);
        next.delete(move.card.id);
        return next;
      });
      toast.error("staleVersion" in result ? STALE_MOVE : result.error);
      router.refresh();
    },
    [router],
  );

  const actions = useMemo<BoardActions>(
    () => ({
      startDrag: (card, from) => setDragging({ card, from }),
      endDrag: () => setDragging(null),
      drop: (to) => {
        const current = draggingRef.current;
        setDragging(null);
        if (!current || current.from === to.id) return;
        const move = { card: current.card, from: current.from, to: to.id };
        if (to.kind !== "open") return setAsking(move);
        void send(move, to.name);
      },
    }),
    [send],
  );
  const state = useMemo<BoardState>(() => ({ dragging, moves }), [dragging, moves]);

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
