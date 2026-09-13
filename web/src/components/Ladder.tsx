"use client";

import { useEffect, useMemo, useRef } from "react";
import type { GameState, TableParams } from "@/lib/game";
import { ladder, netBet, reserveFor } from "@/lib/ladder";
import { fmtMult, fmtToken } from "@/lib/format";

/**
 * Every rung the round can reach, level 1 at the top. The current level
 * is gold, the next one outlined, rungs the coop cannot pay are dimmed
 * and marked. Scrolls itself to keep the current rung in view.
 */
export function Ladder({ state, params }: { state: GameState; params: TableParams }) {
  const inRound = state.phase !== "idle" && state.phase !== "starting";
  const bet = inRound ? state.bet : netBet(state.amount, params.burnBps);
  const reserve = inRound ? state.reserve : reserveFor(bet, state.bones, params.edgeBps, params.maxWin);
  const rungs = useMemo(() => ladder(bet, state.bones, params.edgeBps, reserve), [bet, state.bones, params.edgeBps, reserve]);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const target = list.querySelector<HTMLElement>(".rung.next") ?? list.querySelector<HTMLElement>(".rung.current");
    if (!target) return;
    const top = target.offsetTop - list.clientHeight / 2 + target.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [state.level, state.bones, state.phase]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">The ladder</span>
        <span className="num text-[11px] text-ink-3">{rungs.length} rungs</span>
      </div>
      <ol ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {rungs.map((r) => {
          const cls = ["rung"];
          if (inRound && r.level < state.level) cls.push("reached");
          if (inRound && r.level === state.level) cls.push("current");
          if (inRound && r.level === state.level + 1 && (state.phase === "live" || state.phase === "lifting")) cls.push("next");
          if (r.capped) cls.push("capped");
          return (
            <li key={r.level} className={cls.join(" ")}>
              <span className="text-ink-4">{r.level}</span>
              <span>{fmtMult(r.multiplier)}</span>
              <span className="text-right">
                {fmtToken(r.payout, params.decimals)}
                {r.capped ? <span className="ml-1 text-[9px] uppercase tracking-[0.15em] text-gold">cap</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
