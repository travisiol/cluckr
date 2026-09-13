"use client";

import { useSyncExternalStore } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { chain } from "@/lib/chain";
import { isLive } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";

const noop = () => () => {};
/** false during SSR and hydration, true once the client owns the tree. */
export const useMounted = () =>
  useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

/**
 * Injected-wallet connect. Three states: no wallet, wrong chain,
 * connected. Nothing here sends a transaction.
 */
export function ConnectButton({ className = "" }: { className?: string }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const mounted = useMounted();

  if (!mounted) {
    return (
      <button type="button" className={`btn btn-glass btn-sm ${className}`} disabled>
        Connect wallet
      </button>
    );
  }

  if (!isLive) {
    return (
      <span className={`chip ${className}`} title="No contract address is configured; the practice table is the only table.">
        <span className="dot bg-ink-4" />
        Practice only
      </span>
    );
  }

  if (!isConnected || !address) {
    const injected = connectors[0];
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>
        <button type="button" className="btn btn-glass btn-sm" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
        {!injected ? <span className="text-xs text-ink-3">No wallet found</span> : error ? <span className="text-xs text-red">{error.message.split("\n")[0]}</span> : null}
      </div>
    );
  }

  const wrongChain = chainId !== chain.id;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {wrongChain ? (
        <button type="button" className="btn btn-gold btn-sm" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
          {switching ? "Switching…" : `Switch to ${chain.name}`}
        </button>
      ) : null}
      <span className="chip">
        <span className={`dot ${wrongChain ? "bg-red" : "bg-gold"}`} />
        <span className="font-mono">{shortAddress(address)}</span>
      </span>
      <button type="button" className="btn btn-glass btn-sm" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
