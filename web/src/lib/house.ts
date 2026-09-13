import type { Hex } from "viem";
import { HOUSE_URL } from "@/lib/contracts";

/*
  The house, over HTTP. Two calls: a signed commitment before a round, and
  the seed for a lift once the lift is on chain. The browser never trusts
  a seed without hashing it against the commitment first (see fair.ts).
*/

export interface Commitment {
  tip: Hex;
  player: Hex;
  expiry: number;
  signature: Hex;
  house: Hex;
  chainLength: number;
}

export interface HouseHealth {
  ok: boolean;
  house: Hex;
  houseMatches: boolean | null;
  cluckr: Hex;
  chainId: number;
  liveRounds: number;
  revealAfterSeconds: number;
  commitMinutes: number;
}

export class HouseUnreachable extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${HOUSE_URL}${path}`, { ...init, cache: "no-store" });
  } catch {
    throw new HouseUnreachable("The house is not answering.");
  }
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

export async function houseHealth(): Promise<HouseHealth | null> {
  try {
    const { status, body } = await call<HouseHealth>("/health");
    return status === 200 ? body : null;
  } catch {
    return null;
  }
}

export async function requestCommitment(player: Hex): Promise<Commitment> {
  const { status, body } = await call<Commitment & { error?: string }>("/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ player }),
  });
  if (status !== 200) throw new Error(body.error ?? `The house refused the commitment (${status}).`);
  return body;
}

export interface RevealAnswer {
  seed: Hex;
  settles: boolean;
  cell: number;
  nonce: Hex;
}

/**
 * Asks for the seed of lift `level` until the house has it, or until
 * `timeoutMs` — after which the contract's own timeout is the remedy.
 */
export async function awaitReveal(id: bigint, level: number, timeoutMs: number, signal?: AbortSignal): Promise<RevealAnswer> {
  const started = Date.now();
  let delay = 250;
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      const { status, body } = await call<RevealAnswer & { error?: string }>(`/reveal/${id}/${level}`);
      if (status === 200) return body;
      if (status === 404) throw new Error(body.error ?? "The house does not know this round.");
      // 425: the lift is not on chain from where the house stands yet.
    } catch (e) {
      if (!(e instanceof HouseUnreachable)) throw e;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(1500, delay * 1.4);
  }
  throw new Error("The house went quiet. You can force a cash-out once its time is up.");
}
