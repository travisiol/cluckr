import { createWalletClient, http, parseEther, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chain } from "@/lib/chain";

/*
  The session key: a throwaway account that lives in this browser and is
  named as the round's operator, so every lift is a transaction it signs
  itself — no wallet prompt per cloche. It can only lift and cash out; the
  contract pays the player's wallet, never the operator. It holds gas money
  and nothing else, and gives it back on request.
*/

const KEY = "cluckr.session.v1";

/** ETH forwarded to a fresh session key by `startRound` (Robinhood Chain gas is ~0.00001 ETH per lift). */
export const GAS_STIPEND = parseEther(process.env.NEXT_PUBLIC_GAS_STIPEND_ETH ?? "0.0005");
/** Below this, the next round tops the key up again. */
export const LOW_GAS = GAS_STIPEND / 5n;

export interface Session {
  key: Hex;
  address: Hex;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: string };
    if (!parsed.key || !/^0x[0-9a-fA-F]{64}$/.test(parsed.key)) return null;
    return { key: parsed.key as Hex, address: privateKeyToAccount(parsed.key as Hex).address };
  } catch {
    return null;
  }
}

export function ensureSession(): Session {
  const existing = loadSession();
  if (existing) return existing;
  const key = generatePrivateKey();
  const session = { key, address: privateKeyToAccount(key).address };
  try {
    localStorage.setItem(KEY, JSON.stringify({ key, createdAt: Date.now() }));
  } catch {
    /* private mode: the key lives for this page load only */
  }
  return session;
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}

export function sessionWallet(session: Session): WalletClient {
  return createWalletClient({ account: privateKeyToAccount(session.key), chain, transport: http() });
}

/** Sends everything but the gas of the transfer itself back to `to`. */
export async function returnGas(session: Session, publicClient: PublicClient, to: Hex): Promise<Hex | null> {
  const balance = await publicClient.getBalance({ address: session.address });
  const gasPrice = await publicClient.getGasPrice();
  const fee = 21_000n * ((gasPrice * 12n) / 10n);
  if (balance <= fee) return null;
  const wallet = sessionWallet(session);
  const hash = await wallet.sendTransaction({
    account: wallet.account!,
    chain,
    to,
    value: balance - fee,
    gas: 21_000n,
    gasPrice: (gasPrice * 12n) / 10n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
