"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { MoveDealStageDialog, STALE_MOVE, moveDealStage } from "../_components/move-deal-stage-dialog";
import type { DealStageList } from "../_components/deal-form";
import type { CardData } from "./board-column";

/** A card on its way: where it came from and, once dropped, where it went. */
interface Move {
  card: CardData;
  from: string;
  to: string;
}

interface BoardMoves {
  /** The card being dragged, with the stage it sits in. */
  dragging: { card: CardData; from: string } | null;
  startDrag: (card: CardData, from: string) => void;
  endDrag: () => void;
  /** Drops the dragged card on a stage. A Lost stage asks for the reason first; any other moves at once. */
  drop: (to: { id: string; name: string; kind: "open" | "won" | "lost" }) => void;
  /** Moves sent and not yet shown by the server: the source column hides the card and the target shows it. */
  moves: ReadonlyMap<string, Move>;
}

const Context = createContext<BoardMoves | null>(null);

export function useBoardMoves(): BoardMoves {
  const value = useContext(Context);
  if (!value) throw new Error("useBoardMoves needs a BoardMovesProvider");
  return value;
}

/**
 * Drag and drop for the deal board. A card dropped on another stage moves there on screen at once and the move goes to
 * the server with the version the board read; a refusal puts the card back and says why. A Lost stage opens the move
 * dialog on that stage, because a lost deal keeps its reason. Each card's Move stage button stays the way to move from
 * the keyboard or a touch screen.
 */
export function BoardMovesProvider({ stages, children }: { stages: DealStageList; children: ReactNode }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [dragging, setDragging] = useState<BoardMoves["dragging"]>(null);
  const [moves, setMoves] = useState<Map<string, Move>>(new Map());
  // Moves the server took. They stop counting once the refreshed board shows them, so the old columns never flash back.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Move | null>(null);
  const shown = useMemo(() => (refreshing ? moves : new Map([...moves].filter(([id]) => !settled.has(id)))), [moves, settled, refreshing]);

  function forget(id: string) {
    setMoves((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  async function send(move: Move, stageName: string) {
    // Settled moves the board already shows can go; while a refresh is on its way they still hold the cards in place.
    const done = refreshing ? new Set<string>() : settled;
    setMoves((current) => new Map([...current].filter(([id]) => !done.has(id))).set(move.card.id, move));
    setSettled((ids) => new Set([...ids].filter((id) => !done.has(id) && id !== move.card.id)));
    const result = await moveDealStage(move.card.id, move.to, move.card.version);
    if (result.ok) {
      toast.success(`Moved ${move.card.title} to ${stageName}.`);
      setSettled((ids) => new Set(ids).add(move.card.id));
    } else {
      forget(move.card.id);
      toast.error("staleVersion" in result ? STALE_MOVE : result.error);
    }
    startRefresh(() => router.refresh());
  }

  const value: BoardMoves = {
    dragging,
    moves: shown,
    startDrag: (card, from) => setDragging({ card, from }),
    endDrag: () => setDragging(null),
    drop: (to) => {
      if (!dragging || dragging.from === to.id) return setDragging(null);
      const move = { card: dragging.card, from: dragging.from, to: to.id };
      setDragging(null);
      if (to.kind === "lost") return setAsking(move);
      void send(move, to.name);
    },
  };

  return (
    <Context.Provider value={value}>
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
    </Context.Provider>
  );
}
