"use client";

import { useCallback, useMemo, useState } from "react";
import { Board, type CellView } from "@/components/Board";
import { ConnectButton } from "@/components/ConnectButton";
import { Feed } from "@/components/Feed";
import { Hud } from "@/components/Hud";
import { Ladder } from "@/components/Ladder";
import { Overlay, TABS, type Tab } from "@/components/Overlay";
import { Wordmark } from "@/components/Wordmark";
import { game } from "@/lib/game";
import { fmtTokenCompact } from "@/lib/format";
import { site, CELLS } from "@/lib/site";
import { useGame, useGameBridge } from "@/lib/useGame";
import { useTable } from "@/lib/useTable";

/**
 * The single screen. The board is the page; the HUD floats on the left,
 * the ladder, the coop and the feed on the right; the explanations live
 * in an overlay that closes back onto the table. Nothing scrolls except
 * the lists inside their panels.
 */
export function Table() {
  const table = useTable();
  useGameBridge(table.live ? table.params : null);
  const state = useGame();
  const params = state.mode === "live" ? table.params : game.getParams();
  const [tab, setTab] = useState<Tab | null>(null);
  const [mobilePane, setMobilePane] = useState<"play" | "ladder" | "feed">("play");

  const cells = useMemo<CellView[]>(() => {
    const views: CellView[] = new Array(CELLS).fill("covered");
    const ended = state.phase === "busted" || state.phase === "cashed";
    if (ended) views.fill("dim");
    for (const l of state.lifts) views[l.cell] = l.bone ? "bone" : state.phase === "cashed" ? "gold" : "chicken";
    if (state.pendingCell !== null && state.phase === "lifting") views[state.pendingCell] = "pending";
    return views;
  }, [state.lifts, state.pendingCell, state.phase]);

  const onPick = useCallback((cell: number) => void game.lift(cell), []);
  const interactive = state.phase === "live";
  const mood = state.phase === "busted" ? "busted" : state.phase === "cashed" ? "cashed" : "quiet";

  return (
    <div className="fixed inset-0 flex flex-col">
      <header className="relative z-20 flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <Wordmark />
        <span className="hidden text-[12px] text-ink-3 md:inline">{site.tagline}</span>
        <span className={`chip ml-1 hidden sm:inline-flex ${state.mode === "live" ? "" : ""}`}>
          <span className={`dot ${state.mode === "live" ? "bg-gold" : "bg-ink-4"}`} />
          {state.mode === "live" ? "Live table" : "Practice table"}
        </span>
        <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="About">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="btn btn-glass btn-sm" onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <button type="button" className="btn btn-glass btn-sm ml-auto lg:hidden" onClick={() => setTab("how")}>
          About
        </button>
        <ConnectButton className="lg:ml-2" />
      </header>

      <main className="relative min-h-0 flex-1">
        <div className="absolute inset-x-0 top-0 h-[47%] lg:inset-0 lg:left-[336px] lg:right-[316px] lg:h-auto">
          <Board cells={cells} interactive={interactive} mood={mood} onPick={onPick} className="h-full w-full" />
        </div>

        {/* Left: the HUD (desktop). */}
        <aside className="glass absolute left-3 top-3 bottom-3 hidden w-[320px] flex-col p-5 lg:flex">
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
            <Hud state={state} params={params} balance={table.balance} />
          </div>
          <CoopLine free={table.coop?.free ?? null} burned={table.coop?.totalBurned ?? null} decimals={params.decimals} symbol={params.symbol} live={table.live} />
        </aside>

        {/* Right: ladder and feed (desktop). */}
        <aside className="glass absolute right-3 top-3 bottom-3 hidden w-[300px] flex-col gap-4 p-5 lg:flex">
          <div className="min-h-0 flex-[3]">
            <Ladder state={state} params={params} />
          </div>
          <div className="min-h-0 flex-[2] border-t border-edge pt-4">
            <Feed live={table.live} practice={state.practiceHistory} params={params} />
          </div>
        </aside>

        {/* Narrow screens: the board takes the top, one pane at a time below. */}
        <div className="absolute inset-x-0 bottom-0 flex max-h-[52%] flex-col lg:hidden">
          <div className="seg mx-auto mb-2 self-center">
            {(["play", "ladder", "feed"] as const).map((p) => (
              <button key={p} type="button" aria-pressed={mobilePane === p} onClick={() => setMobilePane(p)}>
                {p === "play" ? "Play" : p === "ladder" ? "Ladder" : "Feed"}
              </button>
            ))}
          </div>
          <div className="glass scroll-thin mx-2 mb-2 min-h-0 flex-1 overflow-y-auto rounded-t-[22px] p-4">
            {mobilePane === "play" ? <Hud state={state} params={params} balance={table.balance} /> : null}
            {mobilePane === "ladder" ? (
              <div className="h-[40vh]">
                <Ladder state={state} params={params} />
              </div>
            ) : null}
            {mobilePane === "feed" ? (
              <div className="h-[40vh]">
                <Feed live={table.live} practice={state.practiceHistory} params={params} />
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <Overlay tab={tab} onClose={() => setTab(null)} onTab={setTab} state={state} params={params} coop={table.coop} />
    </div>
  );
}

function CoopLine({ free, burned, decimals, symbol, live }: { free: bigint | null; burned: bigint | null; decimals: number; symbol: string; live: boolean }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-edge pt-4 text-[11px]">
      <div>
        <div className="label">The coop</div>
        <div className="num mt-1 whitespace-nowrap text-ink">{live && free !== null ? `${fmtTokenCompact(free, decimals)} ${symbol}` : "play money"}</div>
      </div>
      <div>
        <div className="label">Burned</div>
        <div className="num mt-1 whitespace-nowrap text-gold-hot">{live && burned !== null ? `${fmtTokenCompact(burned, decimals)} ${symbol}` : "—"}</div>
      </div>
    </div>
  );
}
