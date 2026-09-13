"use client";

import type { CellView } from "@/components/Board";
import { cellName } from "@/lib/format";

/**
 * The same 25 cloches as buttons: the keyboard path, and the whole board
 * where WebGL is unavailable.
 */
export function BoardFallback({
  cells,
  interactive,
  onPick,
  className = "",
}: {
  cells: CellView[];
  interactive: boolean;
  onPick: (cell: number) => void;
  className?: string;
}) {
  return (
    <div className={`flex h-full w-full items-center justify-center p-4 ${className}`}>
      <div className="grid w-full max-w-[520px] grid-cols-5 gap-2" role="grid" aria-label="The 25 cloches">
        {cells.map((view, cell) => {
          const covered = view === "covered";
          const label =
            view === "chicken" || view === "gold" ? "roast chicken" : view === "bone" ? "bone" : view === "pending" ? "lifting…" : covered ? "covered" : "covered";
          return (
            <button
              key={cell}
              type="button"
              role="gridcell"
              aria-label={`${cellName(cell)}: ${label}`}
              disabled={!interactive || !covered}
              onClick={() => onPick(cell)}
              className={`cloche-btn ${view}`}
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">{cellName(cell)}</span>
              <span className="mt-1 text-sm">
                {view === "chicken" || view === "gold" ? "🍗" : view === "bone" ? "🦴" : view === "pending" ? "…" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
