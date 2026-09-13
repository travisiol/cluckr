import { randomBytes } from "node:crypto";
import { getAddress, keccak256, type Hex } from "viem";
import { config } from "./config.ts";
import { Status, chainNow, readRound, signCommit, type RoundView } from "./chain.ts";
import { bindChainToRound, getChain, saveChain, saveRound, unusedChains } from "./db.ts";

/**
 * The house's two jobs: commit to a hash chain before a round, and reveal
 * exactly one seed per lift — never before the lift is on chain, never
 * one the chain has not asked for.
 */

/** tip = H(seeds[0]); H(seeds[i + 1]) = seeds[i]. seeds[0] settles the first lift. */
export function makeChain(length: number): { tip: Hex; seeds: Hex[] } {
  const seeds: Hex[] = new Array(length);
  seeds[length - 1] = `0x${randomBytes(32).toString("hex")}`;
  for (let i = length - 2; i >= 0; i--) seeds[i] = keccak256(seeds[i + 1]);
  return { tip: keccak256(seeds[0]), seeds };
}

export interface Commitment {
  tip: Hex;
  player: string;
  expiry: number;
  signature: Hex;
  house: string;
  chainLength: number;
}

export class HouseError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export async function issueCommitment(playerRaw: string, houseAddress: string): Promise<Commitment> {
  let player: string;
  try {
    player = getAddress(playerRaw);
  } catch {
    throw new HouseError("player must be an address");
  }
  // The contract compares the expiry with block.timestamp, so it is set from
  // the chain's clock, not this machine's.
  const now = await chainNow();
  if (unusedChains(player, now) >= config.commitsPerPlayer) {
    throw new HouseError(`You already hold ${config.commitsPerPlayer} unused commitments. Start a round with one first.`, 429);
  }
  const { tip, seeds } = makeChain(config.chainLength);
  const expiry = now + config.commitMinutes * 60;
  const signature = await signCommit(tip, player, expiry);
  saveChain(tip, player, expiry, seeds);
  return { tip, player, expiry, signature, house: houseAddress, chainLength: seeds.length };
}

/**
 * The highest seed index the chain has consumed for this round, or -1.
 * A live round with a pending lift is asking for `level`; a live round at
 * rest has consumed `level` seeds (indices 0 … level-1); a busted round
 * consumed one more (the bone); a paid round consumed `level`.
 */
export function consumedUpTo(r: RoundView): number {
  if (r.status === Status.Live) return r.pending ? r.level : r.level - 1;
  if (r.status === Status.Busted) return r.level;
  return r.level - 1;
}

export interface Reveal {
  id: number;
  level: number;
  seed: Hex;
  cell: number;
  nonce: Hex;
  /** true when the seed is answering a lift that is pending right now. */
  settles: boolean;
}

/** The seed for lift `level` of round `id`, if the chain has asked for it. */
export async function revealFor(id: number, level: number): Promise<Reveal> {
  if (!Number.isInteger(id) || id <= 0) throw new HouseError("bad round id");
  if (!Number.isInteger(level) || level < 0 || level >= config.chainLength) throw new HouseError("bad level");
  const r = await readRound(id);
  if (r.status === Status.None) throw new HouseError("no such round", 404);
  const chain = getChain(r.tip);
  if (!chain) throw new HouseError("this round was not committed by this house", 404);
  if (chain.round_id === null) {
    bindChainToRound(r.tip, id);
    saveRound({ id, tip: r.tip, player: r.player, status: r.status, level: r.level, pending: r.pending ? 1 : 0 });
  }
  const upTo = consumedUpTo(r);
  if (level > upTo) {
    throw new HouseError(r.status === Status.Live ? "that lift is not on chain yet" : "the round is over", 425);
  }
  return {
    id,
    level,
    seed: chain.seeds[level] as Hex,
    cell: r.pending && level === r.level ? r.pendingCell : -1,
    nonce: r.pending && level === r.level ? r.pendingNonce : ("0x" as Hex),
    settles: r.status === Status.Live && r.pending && level === r.level,
  };
}

/** Seed for the janitor: only for a live round's pending lift. */
export function pendingSeed(r: RoundView): Hex | null {
  if (r.status !== Status.Live || !r.pending) return null;
  const chain = getChain(r.tip);
  return chain ? (chain.seeds[r.level] as Hex) : null;
}
