import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.ts";
import cluckrAbiJson from "../../web/src/lib/abi/Cluckr.json" with { type: "json" };

/**
 * The chain, seen from the house. Reads rounds, signs commitments, and —
 * for the janitor only — sends `reveal` and `expire` transactions.
 */

export const cluckrAbi = cluckrAbiJson as readonly unknown[] as typeof import("../../web/src/lib/abi/Cluckr.json");

export const chain = defineChain({
  id: config.chainId,
  name: config.chainId === 4663 ? "Robinhood Chain" : config.chainId === 31337 ? "Hardhat" : `Chain ${config.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

export const houseAccount = privateKeyToAccount(config.houseKey as Hex);
export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
export const walletClient = createWalletClient({ account: houseAccount, chain, transport: http(config.rpcUrl) });

export const cluckr = () => getAddress(config.cluckrAddress);

export const Status = { None: 0, Live: 1, Cashed: 2, Busted: 3, Expired: 4 } as const;

export interface RoundView {
  player: string;
  operator: string;
  startedAt: number;
  lastActionAt: number;
  pendingAt: number;
  bones: number;
  level: number;
  pendingCell: number;
  pending: boolean;
  status: number;
  revealedMask: number;
  boneCell: number;
  bet: bigint;
  reserved: bigint;
  tip: Hex;
  commit: Hex;
  pendingNonce: Hex;
  payout: bigint;
}

export async function readRound(id: number | bigint): Promise<RoundView> {
  const r = (await publicClient.readContract({
    address: cluckr(),
    abi: cluckrAbi,
    functionName: "rounds",
    args: [BigInt(id)],
  })) as unknown as {
    player: string;
    operator: string;
    startedAt: bigint;
    lastActionAt: bigint;
    pendingAt: bigint;
    bones: number;
    level: number;
    pendingCell: number;
    pending: boolean;
    status: number;
    revealedMask: number;
    boneCell: number;
    bet: bigint;
    reserved: bigint;
    tip: Hex;
    commit: Hex;
    pendingNonce: Hex;
    payout: bigint;
  };
  return {
    ...r,
    startedAt: Number(r.startedAt),
    lastActionAt: Number(r.lastActionAt),
    pendingAt: Number(r.pendingAt),
    bones: Number(r.bones),
    level: Number(r.level),
    pendingCell: Number(r.pendingCell),
    status: Number(r.status),
    revealedMask: Number(r.revealedMask),
    boneCell: Number(r.boneCell),
  };
}

export async function nextRoundId(): Promise<number> {
  return Number(await publicClient.readContract({ address: cluckr(), abi: cluckrAbi, functionName: "nextRoundId" }));
}

export interface ParamsView {
  edgeBps: number;
  burnBps: number;
  maxPayoutBps: number;
  revealTimeout: number;
  idleTimeout: number;
  minBet: bigint;
  maxBet: bigint;
}

export async function readParams(): Promise<ParamsView> {
  const p = (await publicClient.readContract({ address: cluckr(), abi: cluckrAbi, functionName: "params" })) as unknown as readonly [
    number,
    number,
    number,
    number,
    number,
    bigint,
    bigint,
  ];
  return {
    edgeBps: Number(p[0]),
    burnBps: Number(p[1]),
    maxPayoutBps: Number(p[2]),
    revealTimeout: Number(p[3]),
    idleTimeout: Number(p[4]),
    minBet: p[5],
    maxBet: p[6],
  };
}

export async function onChainHouse(): Promise<string> {
  return (await publicClient.readContract({ address: cluckr(), abi: cluckrAbi, functionName: "house" })) as string;
}

/** The EIP-712 signature the contract checks in `startRound`. */
export async function signCommit(tip: Hex, player: string, expiry: number): Promise<Hex> {
  return houseAccount.signTypedData({
    domain: { name: "Cluckr", version: "1", chainId: chain.id, verifyingContract: cluckr() },
    types: {
      Commit: [
        { name: "tip", type: "bytes32" },
        { name: "player", type: "address" },
        { name: "expiry", type: "uint256" },
      ],
    },
    primaryType: "Commit",
    message: { tip, player: getAddress(player), expiry: BigInt(expiry) },
  });
}

export async function sendReveal(id: number, seed: Hex): Promise<Hex> {
  const hash = await walletClient.writeContract({ address: cluckr(), abi: cluckrAbi, functionName: "reveal", args: [BigInt(id), seed] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function sendExpire(id: number): Promise<Hex> {
  const hash = await walletClient.writeContract({ address: cluckr(), abi: cluckrAbi, functionName: "expire", args: [BigInt(id)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * The clock the contract will see. The latest block can lag on a chain
 * that only seals blocks when there is something to seal (a local node),
 * and its clock can run ahead of this machine's (after evm_increaseTime),
 * so take the latest of the three: wall clock, latest block, pending block.
 */
export async function chainNow(): Promise<number> {
  const wall = Math.floor(Date.now() / 1000);
  const [latest, pending] = await Promise.all([
    publicClient.getBlock().then((b) => Number(b.timestamp)).catch(() => 0),
    publicClient.getBlock({ blockTag: "pending" }).then((b) => Number(b.timestamp)).catch(() => 0),
  ]);
  return Math.max(wall, latest, pending);
}
