"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { CLUCKR_ADDRESS } from "@/lib/contracts";
import type { HistoryEntry, TableParams } from "@/lib/game";
import { fmtMult, fmtToken, shortAddress } from "@/lib/format";
import { multiplierAt } from "@/lib/ladder";

const FEED_WINDOW = 60_000n;

/** The last rounds the chain settled, newest first. */
function useChainFeed(enabled: boolean, params: TableParams): HistoryEntry[] {
  const client = usePublicClient();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    if (!enabled || !client || !CLUCKR_ADDRESS) return;
    const address = CLUCKR_ADDRESS;
    let cancelled = false;
    const read = async () => {
      try {
        const head = await client.getBlockNumber();
        const fromBlock = head > FEED_WINDOW ? head - FEED_WINDOW : 0n;
        const [starts, cashed, busted] = await Promise.all([
          client.getLogs({
            address,
            event: parseAbiItem("event RoundStarted(uint256 indexed id, address indexed player, address operator, uint256 bet, uint8 bones, bytes32 tip, uint256 reserved, uint256 burned)"),
            fromBlock,
          }),
          client.getLogs({ address, event: parseAbiItem("event CashedOut(uint256 indexed id, address indexed player, uint8 level, uint256 payout, bool forced)"), fromBlock }),
          client.getLogs({ address, event: parseAbiItem("event Busted(uint256 indexed id, uint8 level, uint8 cell, bytes32 seed, uint256 lost)"), fromBlock }),
        ]);
        const byId = new Map<bigint, { player: string; bones: number; bet: bigint }>();
        for (const s of starts) byId.set(s.args.id!, { player: s.args.player!, bones: Number(s.args.bones), bet: s.args.bet! });
        const list: (HistoryEntry & { block: bigint; index: number })[] = [];
        for (const c of cashed) {
          const start = byId.get(c.args.id!);
          const level = Number(c.args.level);
          list.push({
            id: `r${c.args.id}`,
            player: c.args.player!,
            bones: start?.bones ?? 0,
            level,
            multiplier: start ? multiplierAt(start.bones, level, params.edgeBps) : 0,
            payout: c.args.payout!,
            bet: start?.bet ?? 0n,
            busted: false,
            at: 0,
            block: c.blockNumber,
            index: c.logIndex,
          });
        }
        for (const b of busted) {
          const start = byId.get(b.args.id!);
          list.push({
            id: `r${b.args.id}`,
            player: start?.player ?? "",
            bones: start?.bones ?? 0,
            level: Number(b.args.level),
            multiplier: 0,
            payout: 0n,
            bet: b.args.lost!,
            busted: true,
            at: 0,
            block: b.blockNumber,
            index: b.logIndex,
          });
        }
        list.sort((a, b) => (a.block === b.block ? b.index - a.index : Number(b.block - a.block)));
        if (!cancelled) setEntries(list.slice(0, 40));
      } catch {
        /* a provider without log filters; the feed stays empty */
      }
    };
    void read();
    const t = setInterval(read, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, client, params.edgeBps]);

  return entries;
}

export function Feed({ live, practice, params }: { live: boolean; practice: HistoryEntry[]; params: TableParams }) {
  const chainFeed = useChainFeed(live, params);
  const entries = live ? chainFeed : practice;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">{live ? "At the table" : "Your practice rounds"}</span>
        <span className="num text-[11px] text-ink-3">{entries.length ? `${entries.length} rounds` : ""}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-[12px] text-ink-3">{live ? "Nothing settled yet. Yours could be first." : "Nothing yet. Lift a cloche."}</p>
      ) : (
        <ol className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {entries.map((e) => (
            <li key={e.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2 py-1 text-[12px]">
              <span className={`dot ${e.busted ? "bg-red" : "bg-gold"}`} />
              <span className="truncate text-ink-2">
                <span className="num">{e.player === "you" ? "you" : e.player ? shortAddress(e.player) : "—"}</span>
                <span className="text-ink-3"> · {e.bones} bones</span>
                {e.busted ? (
                  <span className="text-ink-3">
                    {" "}
                    · bone after {e.level} lift{e.level === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span className="text-ink-3"> · {fmtMult(e.multiplier)}</span>
                )}
              </span>
              <span className={`num text-right ${e.busted ? "text-red" : "text-gold-hot"}`}>
                {e.busted ? `−${fmtToken(e.bet, params.decimals)}` : `+${fmtToken(e.payout, params.decimals)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
