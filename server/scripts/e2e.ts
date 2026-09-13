/**
 * End to end against a local hardhat node:
 *
 *   cd contracts && npm run node            (port 8547)
 *   cd contracts && npm run deploy:local    (writes deployments/localhost.json)
 *   cd server    && npm run e2e
 *
 * Boots the house in-process on port 8796 with a scratch database, then
 * plays real rounds through the HTTP routes and the contract: commitments,
 * lifts from a session key, reveals, cash-outs, the janitor settling an
 * abandoned bone, expiry, and the forced cash-out when the house is dead.
 * Every outcome the chain reports is checked against the local mirror of
 * the roll.
 */
import { readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseEther,
  verifyTypedData,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const PORT = 8796;
const record = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../contracts/deployments/localhost.json"), "utf8")) as {
  cluckr: string;
  token: string;
  house: string;
};

// Hardhat's well-known accounts: #1 is the house (deploy.ts default), #2 is Alice.
const HOUSE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ALICE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

process.env.RPC_URL = RPC;
process.env.CHAIN_ID = "31337";
process.env.CLUCKR_ADDRESS = record.cluckr;
process.env.HOUSE_KEY = HOUSE_KEY;
process.env.PORT = String(PORT);
process.env.DB_PATH = resolve(import.meta.dirname, "../data/e2e.sqlite");
process.env.REVEAL_AFTER_SECONDS = "2";
process.env.JANITOR_SECONDS = "2";
rmSync(process.env.DB_PATH, { force: true });
rmSync(process.env.DB_PATH + "-wal", { force: true });
rmSync(process.env.DB_PATH + "-shm", { force: true });

const { startHttp } = await import("../src/http.ts");
const { startJanitor, stopJanitor, sweep } = await import("../src/janitor.ts");
const { cluckrAbi } = await import("../src/chain.ts");
const mockTokenAbi = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../web/src/lib/abi/MockToken.json"), "utf8"));

const chain = defineChain({ id: 31337, name: "Hardhat", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const alice = privateKeyToAccount(ALICE_KEY);
const aliceWallet = createWalletClient({ account: alice, chain, transport: http(RPC) });
const CLUCKR = getAddress(record.cluckr);
const TOKEN = getAddress(record.token);
const HOUSE = getAddress(record.house);

let checks = 0;
function check(cond: unknown, what: string): void {
  checks += 1;
  if (!cond) {
    console.error(`  ✗ ${what}`);
    process.exitCode = 1;
    throw new Error(what);
  }
  console.log(`  ✓ ${what}`);
}

const api = `http://localhost:${PORT}`;
async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(api + path);
  return { status: res.status, body: (await res.json()) as T };
}

type Commitment = { tip: Hex; expiry: number; signature: Hex; house: string; player: string };
type RevealBody = { seed: Hex; settles: boolean; error?: string };

async function round(id: bigint) {
  return (await pub.readContract({ address: CLUCKR, abi: cluckrAbi, functionName: "rounds", args: [id] })) as unknown as {
    player: string;
    level: number;
    pending: boolean;
    status: number;
    commit: Hex;
    bones: number;
    bet: bigint;
    reserved: bigint;
    payout: bigint;
    revealedMask: number;
    pendingAt: bigint;
    lastActionAt: bigint;
  };
}

function isBone(id: bigint, seed: Hex, nonce: Hex, cell: number, level: number, bones: number): boolean {
  const roll = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "address" }], [seed, nonce, cell, id, CLUCKR])));
  return roll % BigInt(25 - level) < BigInt(bones);
}

async function increaseTime(seconds: number) {
  await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
}

async function commitFor(player: string): Promise<Commitment> {
  const { status, body } = await post<Commitment>("/commit", { player });
  if (status !== 200) throw new Error(`commit failed: ${JSON.stringify(body)}`);
  return body;
}

async function startRound(amount: bigint, bones: number, c: Commitment, operator: `0x${string}`, gas: bigint): Promise<bigint> {
  const hash = await aliceWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "startRound", args: [amount, bones, c.tip, BigInt(c.expiry), c.signature, operator], value: gas });
  await pub.waitForTransactionReceipt({ hash });
  return (await pub.readContract({ address: CLUCKR, abi: cluckrAbi, functionName: "roundOf", args: [alice.address] })) as bigint;
}

/** A previous run may have left Alice mid-round; the chain lets anyone close it once both timeouts have passed. */
async function closeLeftovers() {
  const live = (await pub.readContract({ address: CLUCKR, abi: cluckrAbi, functionName: "roundOf", args: [alice.address] })) as bigint;
  if (live === 0n) return;
  await increaseTime(600 + 3600 + 1);
  const hash = await aliceWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "expire", args: [live] });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`(closed leftover round ${live})`);
}

async function main() {
  const server = startHttp(PORT);
  try {
    await closeLeftovers();
    console.log("\n— health");
    const health = await get<{ ok: boolean; house: string; houseMatches: boolean }>("/health");
    check(health.status === 200 && health.body.ok, "house is up and the contract agrees on the key");
    check(health.body.house.toLowerCase() === HOUSE.toLowerCase(), "house address matches the deployment record");

    console.log("\n— commitments");
    const bad = await post<{ error: string }>("/commit", { player: "nope" });
    check(bad.status === 400, "a bad player address is refused");
    const c1 = await commitFor(alice.address);
    const valid = await verifyTypedData({
      address: HOUSE,
      domain: { name: "Cluckr", version: "1", chainId: 31337, verifyingContract: CLUCKR },
      types: { Commit: [{ name: "tip", type: "bytes32" }, { name: "player", type: "address" }, { name: "expiry", type: "uint256" }] },
      primaryType: "Commit",
      message: { tip: c1.tip, player: alice.address, expiry: BigInt(c1.expiry) },
      signature: c1.signature,
    });
    check(valid, "the commitment is signed by the house for this player");
    await commitFor(alice.address);
    await commitFor(alice.address);
    const spam = await post<{ error: string }>("/commit", { player: alice.address });
    check(spam.status === 429, "a fourth unused commitment is refused");

    // Alice approves the table once.
    const approve = await aliceWallet.writeContract({ address: TOKEN, abi: mockTokenAbi, functionName: "approve", args: [CLUCKR, 2n ** 255n] });
    await pub.waitForTransactionReceipt({ hash: approve });

    console.log("\n— a round played from a session key");
    const opKey = `0x${randomBytes(32).toString("hex")}` as Hex;
    const operator = privateKeyToAccount(opKey);
    const opWallet = createWalletClient({ account: operator, chain, transport: http(RPC) });
    const id = await startRound(parseEther("100"), 3, c1, operator.address, parseEther("0.01"));
    check(id > 0n, `round ${id} is live`);
    check((await pub.getBalance({ address: operator.address })) === parseEther("0.01"), "the session key received its gas money");
    const early = await get<RevealBody>(`/reveal/${id}/0`);
    check(early.status === 425, "the house will not reveal a lift that is not on chain");

    let level = 0;
    let prevSeed: Hex = `0x${"0".repeat(64)}`;
    let alive = true;
    const cells = [0, 6, 12, 18];
    for (const cell of cells) {
      const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
      const hash = await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "pick", args: [id, cell, nonce, prevSeed] });
      await pub.waitForTransactionReceipt({ hash });
      const pending = await round(id);
      if (pending.status !== 1) {
        alive = false;
        break;
      }
      check(pending.pending && pending.level === level, `lift ${level} (cloche ${cell}) is pending on chain`);
      const reveal = await get<RevealBody>(`/reveal/${id}/${level}`);
      check(reveal.status === 200 && reveal.body.settles, `the house revealed seed ${level}`);
      check(keccak256(reveal.body.seed) === pending.commit, "the seed hashes to the commitment the chain holds");
      const bone = isBone(id, reveal.body.seed, nonce, cell, level, 3);
      console.log(`    cloche ${cell}: ${bone ? "BONE" : "chicken"}`);
      prevSeed = reveal.body.seed;
      if (bone) {
        // The player would rather not settle a bone. The next call carrying the seed does it anyway.
        const h2 = await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "cashout", args: [id, prevSeed] });
        await pub.waitForTransactionReceipt({ hash: h2 });
        const after = await round(id);
        check(after.status === 3 && after.payout === 0n, "the chain agrees: busted, nothing paid");
        alive = false;
        break;
      }
      level += 1;
    }
    if (alive) {
      const balBefore = (await pub.readContract({ address: TOKEN, abi: mockTokenAbi, functionName: "balanceOf", args: [alice.address] })) as bigint;
      const h = await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "cashout", args: [id, prevSeed] });
      await pub.waitForTransactionReceipt({ hash: h });
      const after = await round(id);
      const expected = (await pub.readContract({ address: CLUCKR, abi: cluckrAbi, functionName: "payoutAt", args: [after.bet, 3, level] })) as bigint;
      const balAfter = (await pub.readContract({ address: TOKEN, abi: mockTokenAbi, functionName: "balanceOf", args: [alice.address] })) as bigint;
      check(after.status === 2 && after.level === level, `cashed out at level ${level}`);
      check(balAfter - balBefore === (expected < after.reserved ? expected : after.reserved), "the player received the ladder's payout, not the session key");
    }
    const past = await get<RevealBody>(`/reveal/${id}/0`);
    check(past.status === 200, "seeds of a finished round stay readable");
    check((await pub.getBalance({ address: operator.address })) < parseEther("0.01"), "the session key paid the gas");

    console.log("\n— the janitor settles a lift the player walked away from");
    startJanitor();
    const c2 = await commitFor(alice.address);
    const id2 = await startRound(parseEther("50"), 10, c2, operator.address, 0n);
    const nonce2 = `0x${randomBytes(32).toString("hex")}` as Hex;
    const hp = await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "pick", args: [id2, 3, nonce2, `0x${"0".repeat(64)}`] });
    await pub.waitForTransactionReceipt({ hash: hp });
    const r2 = await get<RevealBody>(`/reveal/${id2}/0`);
    const bone2 = isBone(id2, r2.body.seed, nonce2, 3, 0, 10);
    await increaseTime(3);
    let settled = false;
    for (let i = 0; i < 20 && !settled; i++) {
      await sweep();
      const s = await round(id2);
      settled = !s.pending;
      if (!settled) await new Promise((r) => setTimeout(r, 300));
    }
    const s2 = await round(id2);
    check(settled, "the janitor posted the seed on chain");
    check(bone2 ? s2.status === 3 : s2.status === 1 && s2.level === 1, `the chain's verdict (${bone2 ? "bone" : "chicken"}) matches the mirror`);

    console.log("\n— the janitor closes an idle round");
    if (s2.status === 1) {
      await increaseTime(3601);
      let expired = false;
      for (let i = 0; i < 20 && !expired; i++) {
        await sweep();
        expired = (await round(id2)).status === 4;
        if (!expired) await new Promise((r) => setTimeout(r, 300));
      }
      const e = await round(id2);
      check(expired && e.payout > 0n, `round ${id2} expired at level ${e.level} and paid the standing`);
    } else {
      const c3 = await commitFor(alice.address);
      const id3 = await startRound(parseEther("20"), 3, c3, operator.address, 0n);
      await increaseTime(3601);
      let expired = false;
      for (let i = 0; i < 20 && !expired; i++) {
        await sweep();
        expired = (await round(id3)).status === 4;
        if (!expired) await new Promise((r) => setTimeout(r, 300));
      }
      const e = await round(id3);
      check(expired && e.payout === e.bet, `round ${id3} expired untouched and the stake came back`);
    }
    stopJanitor();

    console.log("\n— the house dies mid-lift: the player forces a cash-out");
    const c4 = await commitFor(alice.address);
    const id4 = await startRound(parseEther("30"), 5, c4, operator.address, 0n);
    const hq = await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "pick", args: [id4, 7, `0x${randomBytes(32).toString("hex")}`, `0x${"0".repeat(64)}`] });
    await pub.waitForTransactionReceipt({ hash: hq });
    let refused = false;
    try {
      await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "forceCashout", args: [id4] });
    } catch (e) {
      refused = String((e as Error).message).includes("the house still has time");
    }
    check(refused, "forcing before the reveal timeout is refused");
    await increaseTime(601);
    const before4 = (await pub.readContract({ address: TOKEN, abi: mockTokenAbi, functionName: "balanceOf", args: [alice.address] })) as bigint;
    const hf = await opWallet.writeContract({ address: CLUCKR, abi: cluckrAbi, functionName: "forceCashout", args: [id4] });
    await pub.waitForTransactionReceipt({ hash: hf });
    const r4 = await round(id4);
    const after4 = (await pub.readContract({ address: TOKEN, abi: mockTokenAbi, functionName: "balanceOf", args: [alice.address] })) as bigint;
    const expected4 = (await pub.readContract({ address: CLUCKR, abi: cluckrAbi, functionName: "payoutAt", args: [r4.bet, 5, 1] })) as bigint;
    check(r4.status === 2 && r4.level === 1 && after4 - before4 === expected4, "silence paid the player as if the lift were a chicken");

    console.log(`\n${checks} checks passed`);
  } finally {
    stopJanitor();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
