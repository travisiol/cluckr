import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { CELLS } from "@/lib/site";

/*
  The fairness maths, mirrored from the contract so the browser can check
  every seed the house reveals before it trusts a single chicken.

  A hash chain: tip = H(s0), H(s1) = s0, H(s2) = s1, … The house signs the
  tip before the round; the seed for lift i is s_i, and it is valid only if
  it hashes to the commitment the chain currently holds.
*/

export const ZERO_SEED: Hex = `0x${"0".repeat(64)}`;

export function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A chain the browser plays against itself on the practice table. */
export function makeChain(length = CELLS): { tip: Hex; seeds: Hex[] } {
  const seeds: Hex[] = new Array(length);
  seeds[length - 1] = randomHex32();
  for (let i = length - 2; i >= 0; i--) seeds[i] = keccak256(seeds[i + 1]);
  return { tip: keccak256(seeds[0]), seeds };
}

/** Does `seed` hash to `commit`? The one check that makes a reveal honest. */
export function seedMatches(seed: Hex, commit: Hex): boolean {
  return keccak256(seed).toLowerCase() === commit.toLowerCase();
}

/** Mirrors Cluckr.roll. */
export function roll(cluckr: Hex, id: bigint, seed: Hex, nonce: Hex, cell: number): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "address" }],
        [seed, nonce, cell, id, cluckr],
      ),
    ),
  );
}

/** Mirrors the contract's bone test: bones / (cloches still covered). */
export function isBone(cluckr: Hex, id: bigint, seed: Hex, nonce: Hex, cell: number, level: number, bones: number): boolean {
  return roll(cluckr, id, seed, nonce, cell) % BigInt(CELLS - level) < BigInt(bones);
}

export interface Lift {
  level: number;
  cell: number;
  nonce: Hex;
  seed: Hex;
  bone: boolean;
}

/**
 * Re-checks a whole round from its tip: every seed links to the one before
 * it and every verdict matches the roll. What the "Verify" panel runs.
 */
export function verifyRound(cluckr: Hex, id: bigint, tip: Hex, lifts: Lift[], bones: number): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  let commit = tip;
  lifts.forEach((lift, i) => {
    if (lift.level !== i) failures.push(`lift ${i}: recorded as level ${lift.level}`);
    if (!seedMatches(lift.seed, commit)) failures.push(`lift ${i}: seed does not hash to the commitment`);
    const bone = isBone(cluckr, id, lift.seed, lift.nonce, lift.cell, i, bones);
    if (bone !== lift.bone) failures.push(`lift ${i}: the roll says ${bone ? "bone" : "chicken"}, the record says ${lift.bone ? "bone" : "chicken"}`);
    commit = lift.seed;
  });
  return { ok: failures.length === 0, failures };
}
