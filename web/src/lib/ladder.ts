import { CELLS } from "@/lib/site";

/*
  The ladder, exactly as the contract computes it. Integers all the way:
  bet × (1 − edge) × C(25, n) / C(25 − bones, n), floored once at the end.
*/

export const BPS = 10_000n;

/** Payout in token wei after `n` safe lifts. Mirrors Cluckr.payoutAt. */
export function payoutAt(bet: bigint, bones: number, n: number, edgeBps: number): bigint {
  if (bones < 1 || bones > CELLS - 1) throw new RangeError("bones out of range");
  if (n < 0 || n > CELLS - bones) throw new RangeError("level out of range");
  let num = bet * (BPS - BigInt(edgeBps));
  let den = BPS;
  for (let i = 0; i < n; i++) {
    num *= BigInt(CELLS - i);
    den *= BigInt(CELLS - bones - i);
  }
  return num / den;
}

/** The multiplier as a float, for display only. */
export function multiplierAt(bones: number, n: number, edgeBps: number): number {
  let m = (BPS - BigInt(edgeBps)) === 0n ? 0 : Number(BPS - BigInt(edgeBps)) / Number(BPS);
  for (let i = 0; i < n; i++) m *= (CELLS - i) / (CELLS - bones - i);
  return m;
}

/** Chance the next lift is a bone, with `level` chickens already found. */
export function bustChance(bones: number, level: number): number {
  return bones / (CELLS - level);
}

export interface Rung {
  level: number;
  multiplier: number;
  payout: bigint;
  /** true when the round's reserve stops the payout short of the ladder. */
  capped: boolean;
}

/** Every rung of the ladder, level 1 first, with the reserve's cap applied. */
export function ladder(bet: bigint, bones: number, edgeBps: number, reserve?: bigint): Rung[] {
  const rungs: Rung[] = [];
  for (let n = 1; n <= CELLS - bones; n++) {
    const raw = payoutAt(bet, bones, n, edgeBps);
    const capped = reserve !== undefined && raw > reserve;
    rungs.push({ level: n, multiplier: multiplierAt(bones, n, edgeBps), payout: capped ? reserve : raw, capped });
  }
  return rungs;
}

/** What `startRound` would reserve: the ladder's top rung or the coop's cap, whichever is lower. */
export function reserveFor(bet: bigint, bones: number, edgeBps: number, maxWin: bigint): bigint {
  const ceiling = payoutAt(bet, bones, CELLS - bones, edgeBps);
  const cap = bet + maxWin;
  return ceiling < cap ? ceiling : cap;
}

/** The net stake after the burn. */
export function netBet(amount: bigint, burnBps: number): bigint {
  return amount - (amount * BigInt(burnBps)) / BPS;
}
