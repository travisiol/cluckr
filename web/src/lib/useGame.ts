"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { game, type GameState, type TableParams } from "@/lib/game";
import { isLive } from "@/lib/contracts";
import { chain } from "@/lib/chain";

const serverSnapshot = game.getState();

export function useGame(): GameState {
  return useSyncExternalStore(game.subscribe, game.getState, () => serverSnapshot);
}

/**
 * Keeps the store wired to wagmi: clients, the connected account and the
 * table's parameters. Flips to the live table when a wallet connects on
 * the right chain, and picks up a round left open.
 */
export function useGameBridge(params: TableParams | null): void {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { address, chainId, isConnected } = useAccount();
  const onChain = isConnected && chainId === chain.id && isLive;

  useEffect(() => {
    game.hydrate();
  }, []);

  useEffect(() => {
    game.attach(publicClient ?? null, walletClient ?? null, onChain && address ? address : null, params);
  }, [publicClient, walletClient, address, onChain, params]);

  useEffect(() => {
    if (onChain && address) {
      game.setMode("live");
      void game.resume();
    } else {
      game.setMode("practice");
    }
  }, [onChain, address]);
}
