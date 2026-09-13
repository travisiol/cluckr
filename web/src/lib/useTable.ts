"use client";

import { useMemo } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { CLUCKR_ADDRESS, TOKEN_ADDRESS, cluckrAbi, erc20Abi, isLive } from "@/lib/contracts";
import { PRACTICE_PARAMS, type TableParams } from "@/lib/game";

export interface Coop {
  free: bigint;
  reserved: bigint;
  totalWagered: bigint;
  totalPaid: bigint;
  totalBurned: bigint;
  roundsPlayed: bigint;
  roundsBusted: bigint;
  paused: boolean;
  house: `0x${string}` | null;
}

export interface Table {
  live: boolean;
  params: TableParams;
  coop: Coop | null;
  balance: bigint | null;
  refetch: () => void;
}

const ZERO: `0x${string}` = "0x0000000000000000000000000000000000000000";

/** The table as the chain sees it, refreshed every few seconds. */
export function useTable(): Table {
  const { address } = useAccount();
  const cluckr = CLUCKR_ADDRESS ?? ZERO;
  const token = TOKEN_ADDRESS ?? ZERO;
  const { data, refetch } = useReadContracts({
    contracts: [
      { address: cluckr, abi: cluckrAbi, functionName: "params" },
      { address: cluckr, abi: cluckrAbi, functionName: "maxWin" },
      { address: cluckr, abi: cluckrAbi, functionName: "freeBankroll" },
      { address: cluckr, abi: cluckrAbi, functionName: "reserved" },
      { address: cluckr, abi: cluckrAbi, functionName: "totalWagered" },
      { address: cluckr, abi: cluckrAbi, functionName: "totalPaid" },
      { address: cluckr, abi: cluckrAbi, functionName: "totalBurned" },
      { address: cluckr, abi: cluckrAbi, functionName: "roundsPlayed" },
      { address: cluckr, abi: cluckrAbi, functionName: "roundsBusted" },
      { address: cluckr, abi: cluckrAbi, functionName: "paused" },
      { address: cluckr, abi: cluckrAbi, functionName: "house" },
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [address ?? ZERO] },
    ],
    query: { enabled: isLive, refetchInterval: 8_000 },
  });

  return useMemo(() => {
    const ok = isLive && data && data.every((d, i) => d.status === "success" || i === 13);
    if (!ok) return { live: false, params: PRACTICE_PARAMS, coop: null, balance: null, refetch };
    const p = data[0].result as unknown as readonly [number, number, number, number, number, bigint, bigint];
    const decimals = Number(data[11].result);
    const symbol = String(data[12].result);
    const params: TableParams = {
      edgeBps: Number(p[0]),
      burnBps: Number(p[1]),
      maxPayoutBps: Number(p[2]),
      revealTimeout: Number(p[3]),
      idleTimeout: Number(p[4]),
      minBet: p[5],
      maxBet: p[6],
      maxWin: data[1].result as bigint,
      decimals,
      symbol,
    };
    const coop: Coop = {
      free: data[2].result as bigint,
      reserved: data[3].result as bigint,
      totalWagered: data[4].result as bigint,
      totalPaid: data[5].result as bigint,
      totalBurned: data[6].result as bigint,
      roundsPlayed: data[7].result as bigint,
      roundsBusted: data[8].result as bigint,
      paused: Boolean(data[9].result),
      house: (data[10].result as `0x${string}`) ?? null,
    };
    const balance = data[13].status === "success" ? (data[13].result as bigint) : null;
    return { live: true, params, coop, balance, refetch };
  }, [data, refetch]);
}
