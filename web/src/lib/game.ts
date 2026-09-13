import { parseAbiItem, type Hex, type PublicClient, type WalletClient } from "viem";
import { CLUCKR_ADDRESS, TOKEN_ADDRESS, cluckrAbi, erc20Abi, Status } from "@/lib/contracts";
import { ZERO_SEED, isBone, makeChain, randomHex32, seedMatches } from "@/lib/fair";
import { awaitReveal, requestCommitment } from "@/lib/house";
import { multiplierAt, netBet, payoutAt, reserveFor } from "@/lib/ladder";
import { GAS_STIPEND, LOW_GAS, ensureSession, sessionWallet, type Session } from "@/lib/session";
import { CELLS } from "@/lib/site";
import { chain } from "@/lib/chain";

/*
  The game, as a small store outside React. One instance per page; the
  components read it through useGame() and call its methods. Two tables
  share one state shape:

    practice  the browser is its own house: a hash chain it makes itself,
              play money, instant reveals. Nothing leaves the tab.
    live      every lift is a transaction from the session key, every seed
              comes from the house and is hashed against the commitment
              before a single chicken is shown.
*/

export type Mode = "practice" | "live";
export type Phase = "idle" | "starting" | "live" | "lifting" | "cashing" | "busted" | "cashed";

export interface Lift {
  level: number;
  cell: number;
  nonce: Hex;
  seed: Hex;
  bone: boolean;
}

export interface TableParams {
  edgeBps: number;
  burnBps: number;
  maxPayoutBps: number;
  revealTimeout: number;
  idleTimeout: number;
  minBet: bigint;
  maxBet: bigint;
  /** Most one round may win right now. */
  maxWin: bigint;
  decimals: number;
  symbol: string;
}

export const PRACTICE_PARAMS: TableParams = {
  edgeBps: 200,
  burnBps: 100,
  maxPayoutBps: 500,
  revealTimeout: 600,
  idleTimeout: 3600,
  minBet: 10n ** 18n,
  maxBet: 10n ** 24n,
  maxWin: 50_000n * 10n ** 18n,
  decimals: 18,
  symbol: "CLUCK",
};

export interface GameState {
  mode: Mode;
  phase: Phase;
  roundId: bigint | null;
  /** Gross amount typed in, before the burn. */
  amount: bigint;
  /** Net stake, after the burn. */
  bet: bigint;
  bones: number;
  level: number;
  lifts: Lift[];
  pendingCell: number | null;
  /** The lift the chain still holds open, if any; its seed, once known, rides in the next transaction. */
  lastSeed: Hex;
  tip: Hex | null;
  commit: Hex | null;
  reserve: bigint;
  payout: bigint | null;
  boneCell: number | null;
  forced: boolean;
  /** Unix seconds the pending lift was placed at (chain time), for the force timer. */
  pendingSince: number | null;
  error: string | null;
  busy: string | null;
  practiceBalance: bigint;
  practiceHistory: HistoryEntry[];
  txStart: Hex | null;
  txEnd: Hex | null;
}

export interface HistoryEntry {
  id: string;
  player: string;
  bones: number;
  level: number;
  multiplier: number;
  payout: bigint;
  bet: bigint;
  busted: boolean;
  at: number;
}

const PRACTICE_BALANCE_KEY = "cluckr.practice.balance.v1";
const PRACTICE_START = 10_000n * 10n ** 18n;
const PRACTICE_HOUSE: Hex = "0x00000000000000000000000000000000000c1ac7";

function loadPracticeBalance(): bigint {
  try {
    const raw = localStorage.getItem(PRACTICE_BALANCE_KEY);
    if (raw && /^\d+$/.test(raw)) return BigInt(raw);
  } catch {
    /* fall through */
  }
  return PRACTICE_START;
}

function savePracticeBalance(b: bigint): void {
  try {
    localStorage.setItem(PRACTICE_BALANCE_KEY, b.toString());
  } catch {
    /* private mode */
  }
}

type Listener = () => void;

/** The first line of a viem / wallet error, or the contract's revert string. */
export function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; cause?: { reason?: string; shortMessage?: string } };
  const reason = err?.cause?.reason;
  if (reason) return reason;
  const msg = err?.shortMessage ?? err?.message ?? String(e);
  const m = /reason string '([^']+)'/.exec(msg) ?? /reverted with the following reason:\s*([^\n]+)/.exec(msg);
  if (m) return m[1];
  if (/user rejected|denied/i.test(msg)) return "You closed the wallet prompt.";
  return msg.split("\n")[0].slice(0, 160);
}

export class Game {
  private state: GameState;
  private listeners = new Set<Listener>();
  private practiceChain: { tip: Hex; seeds: Hex[] } | null = null;
  private practiceRound = 0n;
  private params: TableParams = PRACTICE_PARAMS;
  private publicClient: PublicClient | null = null;
  private walletClient: WalletClient | null = null;
  private account: Hex | null = null;
  private session: Session | null = null;
  private liftLock = false;

  constructor() {
    this.state = {
      mode: "practice",
      phase: "idle",
      roundId: null,
      amount: 100n * 10n ** 18n,
      bet: 0n,
      bones: 3,
      level: 0,
      lifts: [],
      pendingCell: null,
      lastSeed: ZERO_SEED,
      tip: null,
      commit: null,
      reserve: 0n,
      payout: null,
      boneCell: null,
      forced: false,
      pendingSince: null,
      error: null,
      busy: null,
      practiceBalance: PRACTICE_START,
      practiceHistory: [],
      txStart: null,
      txEnd: null,
    };
  }

  // ── store plumbing ─────────────────────────────────────────────────

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): GameState => this.state;

  private set(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Called once on the client, after hydration. */
  hydrate(): void {
    this.set({ practiceBalance: loadPracticeBalance() });
  }

  attach(publicClient: PublicClient | null, walletClient: WalletClient | null, account: Hex | null, params: TableParams | null): void {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    if (params) this.params = params;
  }

  getParams(): TableParams {
    return this.state.mode === "live" ? this.params : PRACTICE_PARAMS;
  }

  setMode(mode: Mode): void {
    if (this.state.phase !== "idle" && this.state.phase !== "busted" && this.state.phase !== "cashed") return;
    this.set({ mode, phase: "idle", error: null, lifts: [], level: 0, boneCell: null, payout: null, roundId: null, tip: null, commit: null });
  }

  setAmount(amount: bigint): void {
    this.set({ amount, error: null });
  }

  setBones(bones: number): void {
    if (bones < 1 || bones > CELLS - 1) return;
    this.set({ bones, error: null });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** Back to the table after a round ended. */
  reset(): void {
    if (this.state.phase !== "busted" && this.state.phase !== "cashed") return;
    this.set({
      phase: "idle",
      roundId: null,
      level: 0,
      lifts: [],
      pendingCell: null,
      lastSeed: ZERO_SEED,
      tip: null,
      commit: null,
      reserve: 0n,
      payout: null,
      boneCell: null,
      forced: false,
      pendingSince: null,
      error: null,
      txStart: null,
      txEnd: null,
    });
  }

  // ── starting ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state.phase !== "idle") return;
    const { amount, bones } = this.state;
    const p = this.getParams();
    if (amount < p.minBet) return this.fail(`The minimum bet is ${p.minBet / 10n ** BigInt(p.decimals)} ${p.symbol}.`);
    if (amount > p.maxBet) return this.fail(`The maximum bet is ${p.maxBet / 10n ** BigInt(p.decimals)} ${p.symbol}.`);
    const bet = netBet(amount, p.burnBps);
    const reserve = reserveFor(bet, bones, p.edgeBps, p.maxWin);
    if (reserve < payoutAt(bet, bones, 1, p.edgeBps)) return this.fail("The coop is too small for this bet. Lower it or add fewer bones.");

    if (this.state.mode === "practice") {
      if (amount > this.state.practiceBalance) return this.fail("Not enough play money. It refills when it runs out.");
      this.practiceChain = makeChain();
      this.practiceRound += 1n;
      const balance = this.state.practiceBalance - amount;
      savePracticeBalance(balance);
      this.set({
        phase: "live",
        roundId: this.practiceRound,
        bet,
        reserve,
        level: 0,
        lifts: [],
        pendingCell: null,
        lastSeed: ZERO_SEED,
        tip: this.practiceChain.tip,
        commit: this.practiceChain.tip,
        payout: null,
        boneCell: null,
        forced: false,
        error: null,
        practiceBalance: balance,
      });
      return;
    }

    const pc = this.publicClient;
    const wc = this.walletClient;
    const account = this.account;
    if (!pc || !wc || !account || !CLUCKR_ADDRESS || !TOKEN_ADDRESS) return this.fail("Connect a wallet on the right chain first.");

    this.set({ phase: "starting", error: null, busy: "Checking your balance…" });
    try {
      const [balance, allowance] = await Promise.all([
        pc.readContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        pc.readContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account, CLUCKR_ADDRESS] }),
      ]);
      if (balance < amount) throw new Error(`You hold ${balance / 10n ** BigInt(p.decimals)} ${p.symbol}; the bet is more than that.`);
      if (allowance < amount) {
        this.set({ busy: "Approve the table in your wallet…" });
        const hash = await wc.writeContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: "approve", args: [CLUCKR_ADDRESS, 2n ** 255n], account, chain });
        await pc.waitForTransactionReceipt({ hash });
      }

      this.set({ busy: "Asking the house to commit…" });
      const commitment = await requestCommitment(account);

      this.session = ensureSession();
      const sessionBalance = await pc.getBalance({ address: this.session.address });
      const topUp = sessionBalance < LOW_GAS ? GAS_STIPEND : 0n;

      this.set({ busy: topUp > 0n ? "Put it on the table — the wallet also sends gas money to your session key…" : "Put it on the table in your wallet…" });
      const hash = await wc.writeContract({
        address: CLUCKR_ADDRESS,
        abi: cluckrAbi,
        functionName: "startRound",
        args: [amount, bones, commitment.tip, BigInt(commitment.expiry), commitment.signature, this.session.address],
        value: topUp,
        account,
        chain,
      });
      this.set({ busy: "Waiting for the chain…" });
      await pc.waitForTransactionReceipt({ hash });
      const id = await pc.readContract({ address: CLUCKR_ADDRESS, abi: cluckrAbi, functionName: "roundOf", args: [account] });
      if (id === 0n) throw new Error("The round did not open.");
      const r = await this.readRound(id);
      this.set({
        phase: "live",
        roundId: id,
        bet: r.bet,
        reserve: r.reserved,
        level: 0,
        lifts: [],
        pendingCell: null,
        lastSeed: ZERO_SEED,
        tip: r.tip,
        commit: r.commit,
        payout: null,
        boneCell: null,
        forced: false,
        busy: null,
        txStart: hash,
        txEnd: null,
      });
    } catch (e) {
      this.set({ phase: "idle", busy: null, error: errorText(e) });
    }
  }

  // ── lifting ────────────────────────────────────────────────────────

  async lift(cell: number): Promise<void> {
    const s = this.state;
    if (s.phase !== "live" || this.liftLock) return;
    if (cell < 0 || cell >= CELLS || s.lifts.some((l) => l.cell === cell)) return;
    if (s.level >= CELLS - s.bones) return;
    this.liftLock = true;
    const nonce = randomHex32();
    const level = s.level;
    this.set({ phase: "lifting", pendingCell: cell, error: null });

    try {
      if (s.mode === "practice") {
        await new Promise((r) => setTimeout(r, 420));
        const seed = this.practiceChain!.seeds[level];
        if (!seedMatches(seed, this.state.commit!)) throw new Error("practice chain broke");
        const bone = isBone(PRACTICE_HOUSE, s.roundId!, seed, nonce, cell, level, s.bones);
        this.settle({ level, cell, nonce, seed, bone });
        return;
      }

      const pc = this.publicClient!;
      const id = s.roundId!;
      this.set({ busy: "Lifting…" });
      const hash = await this.sendFromSession("pick", [id, cell, nonce, s.lastSeed]);
      await pc.waitForTransactionReceipt({ hash });
      const placed = await this.readRound(id);
      if (placed.status !== Status.Live) {
        // The seed we carried settled a bone the house had already posted, or the round was closed under us.
        await this.loadRound(id);
        return;
      }
      this.set({ busy: "Waiting for the house…", pendingSince: placed.pendingAt, commit: placed.commit });
      const answer = await awaitReveal(id, level, this.params.revealTimeout * 1000);
      if (!seedMatches(answer.seed, placed.commit)) {
        throw new Error("The house sent a seed that does not hash to its commitment. Do not lift again; force a cash-out when its time is up.");
      }
      const bone = isBone(CLUCKR_ADDRESS!, id, answer.seed, nonce, cell, level, s.bones);
      this.settle({ level, cell, nonce, seed: answer.seed, bone });
      if (bone) {
        // Settle on chain now so the table is free for the next round; the janitor would otherwise do it later.
        try {
          const h = await this.sendFromSession("reveal", [id, answer.seed]);
          await pc.waitForTransactionReceipt({ hash: h });
          this.set({ txEnd: h });
        } catch {
          /* the house's janitor got there first */
        }
      }
    } catch (e) {
      this.set({ phase: "live", pendingCell: null, busy: null, error: errorText(e) });
    } finally {
      this.liftLock = false;
    }
  }

  private settle(lift: Lift): void {
    const s = this.state;
    const lifts = [...s.lifts, lift];
    if (lift.bone) {
      if (s.mode === "practice") this.recordPractice(lifts, true, 0n);
      this.set({ phase: "busted", lifts, level: s.level, pendingCell: null, boneCell: lift.cell, payout: 0n, busy: null, lastSeed: lift.seed, commit: lift.seed, pendingSince: null });
      return;
    }
    const level = s.level + 1;
    const p = this.getParams();
    const done = level === CELLS - s.bones;
    if (done) {
      const payout = this.cap(payoutAt(s.bet, s.bones, level, p.edgeBps));
      if (s.mode === "practice") {
        const balance = s.practiceBalance + payout;
        savePracticeBalance(balance);
        this.recordPractice(lifts, false, payout, level);
        this.set({ phase: "cashed", lifts, level, pendingCell: null, payout, busy: null, lastSeed: lift.seed, commit: lift.seed, practiceBalance: balance, pendingSince: null });
      } else {
        // The contract paid on the reveal; the next read will confirm.
        this.set({ phase: "cashed", lifts, level, pendingCell: null, payout, busy: null, lastSeed: lift.seed, commit: lift.seed, pendingSince: null });
      }
      return;
    }
    this.set({ phase: "live", lifts, level, pendingCell: null, busy: null, lastSeed: lift.seed, commit: lift.seed, pendingSince: null });
  }

  private cap(payout: bigint): bigint {
    return payout > this.state.reserve ? this.state.reserve : payout;
  }

  // ── cashing out ────────────────────────────────────────────────────

  async cashout(): Promise<void> {
    const s = this.state;
    if (s.phase !== "live" || s.level === 0) return;
    const p = this.getParams();
    const payout = this.cap(payoutAt(s.bet, s.bones, s.level, p.edgeBps));

    if (s.mode === "practice") {
      const balance = s.practiceBalance + payout;
      savePracticeBalance(balance);
      this.recordPractice(s.lifts, false, payout, s.level);
      this.set({ phase: "cashed", payout, practiceBalance: balance, error: null });
      return;
    }

    this.set({ phase: "cashing", busy: "Cashing out…", error: null });
    try {
      const pc = this.publicClient!;
      const hash = await this.sendFromSession("cashout", [s.roundId!, s.lastSeed]);
      await pc.waitForTransactionReceipt({ hash });
      const r = await this.readRound(s.roundId!);
      if (r.status === Status.Cashed) {
        this.set({ phase: "cashed", payout: r.payout, level: r.level, busy: null, txEnd: hash });
      } else {
        await this.loadRound(s.roundId!);
      }
    } catch (e) {
      this.set({ phase: "live", busy: null, error: errorText(e) });
    }
  }

  /** The house has been silent past its timeout: take the lift as a chicken and leave. */
  async forceCashout(): Promise<void> {
    const s = this.state;
    if (s.mode !== "live" || !s.roundId || (s.phase !== "live" && s.phase !== "lifting")) return;
    this.set({ phase: "cashing", busy: "Forcing the cash-out…", error: null });
    try {
      const pc = this.publicClient!;
      const hash = await this.sendFromSession("forceCashout", [s.roundId]);
      await pc.waitForTransactionReceipt({ hash });
      await this.loadRound(s.roundId);
      this.set({ txEnd: hash });
    } catch (e) {
      this.set({ phase: "live", busy: null, error: errorText(e) });
    }
  }

  // ── the chain ──────────────────────────────────────────────────────

  private async sendFromSession(functionName: "pick" | "reveal" | "cashout" | "forceCashout", args: readonly unknown[]): Promise<Hex> {
    const pc = this.publicClient!;
    const session = this.session ?? ensureSession();
    this.session = session;
    const balance = await pc.getBalance({ address: session.address });
    const request = { address: CLUCKR_ADDRESS!, abi: cluckrAbi, functionName, args, chain } as const;
    if (balance > 0n) {
      try {
        const wallet = sessionWallet(session);
        // @ts-expect-error — the union of functions is wider than viem's overloads can narrow
        return await wallet.writeContract({ ...request, account: wallet.account! });
      } catch (e) {
        if (!/insufficient funds|gas/i.test(errorText(e))) throw e;
      }
    }
    // No gas on the session key: fall back to the wallet, one prompt.
    if (!this.walletClient || !this.account) throw new Error("The session key is out of gas and no wallet is connected.");
    this.set({ busy: "Session key out of gas — confirm in your wallet…" });
    // @ts-expect-error — same union
    return await this.walletClient.writeContract({ ...request, account: this.account });
  }

  private async readRound(id: bigint) {
    const r = await this.publicClient!.readContract({ address: CLUCKR_ADDRESS!, abi: cluckrAbi, functionName: "rounds", args: [id] });
    return {
      ...r,
      pendingAt: Number(r.pendingAt),
      lastActionAt: Number(r.lastActionAt),
      status: Number(r.status),
      level: Number(r.level),
      bones: Number(r.bones),
      pendingCell: Number(r.pendingCell),
      boneCell: Number(r.boneCell),
      revealedMask: Number(r.revealedMask),
    };
  }

  /**
   * Rebuilds the table from the chain: the round's lifts come from its
   * Picked / Chicken / Busted events, and a lift the chain still holds open
   * is settled through the house if it can be.
   */
  async loadRound(id: bigint): Promise<void> {
    const pc = this.publicClient;
    if (!pc || !CLUCKR_ADDRESS) return;
    this.set({ busy: "Reading the table…" });
    try {
      const r = await this.readRound(id);
      const fromBlock = await this.roundStartBlock(id);
      const [picked, chickens, busted] = await Promise.all([
        pc.getLogs({ address: CLUCKR_ADDRESS, event: parseAbiItem("event Picked(uint256 indexed id, uint8 level, uint8 cell, bytes32 nonce)"), args: { id }, fromBlock }),
        pc.getLogs({ address: CLUCKR_ADDRESS, event: parseAbiItem("event Chicken(uint256 indexed id, uint8 level, uint8 cell, bytes32 seed)"), args: { id }, fromBlock }),
        pc.getLogs({ address: CLUCKR_ADDRESS, event: parseAbiItem("event Busted(uint256 indexed id, uint8 level, uint8 cell, bytes32 seed, uint256 lost)"), args: { id }, fromBlock }),
      ]);
      const nonces = new Map<number, Hex>();
      for (const log of picked) nonces.set(Number(log.args.level), log.args.nonce!);
      const lifts: Lift[] = chickens
        .map((log) => ({ level: Number(log.args.level) - 1, cell: Number(log.args.cell), seed: log.args.seed!, nonce: nonces.get(Number(log.args.level) - 1) ?? ZERO_SEED, bone: false }))
        .sort((a, b) => a.level - b.level);
      for (const log of busted) lifts.push({ level: Number(log.args.level), cell: Number(log.args.cell), seed: log.args.seed!, nonce: nonces.get(Number(log.args.level)) ?? ZERO_SEED, bone: true });
      const last = lifts.length ? lifts[lifts.length - 1].seed : ZERO_SEED;

      const base = {
        mode: "live" as const,
        roundId: id,
        bet: r.bet,
        bones: r.bones,
        reserve: r.reserved,
        tip: r.tip,
        commit: r.commit,
        lifts,
        level: r.level,
        lastSeed: last,
        busy: null,
        pendingCell: null,
        pendingSince: null,
        forced: false,
      };
      if (r.status === Status.Busted) {
        this.set({ ...base, phase: "busted", boneCell: r.boneCell, payout: 0n });
        return;
      }
      if (r.status === Status.Cashed || r.status === Status.Expired) {
        this.set({ ...base, phase: "cashed", payout: r.payout, forced: r.status === Status.Cashed && lifts.length < r.level });
        return;
      }
      if (!r.pending) {
        this.set({ ...base, phase: "live", payout: null, boneCell: null });
        return;
      }
      // A lift is open on chain. Ask the house for its seed and settle it here.
      this.set({ ...base, phase: "lifting", pendingCell: r.pendingCell, pendingSince: r.pendingAt, payout: null, boneCell: null, busy: "Waiting for the house…" });
      const nonce = r.pendingNonce;
      const answer = await awaitReveal(id, r.level, this.params.revealTimeout * 1000);
      if (!seedMatches(answer.seed, r.commit)) throw new Error("The house sent a seed that does not hash to its commitment.");
      const bone = isBone(CLUCKR_ADDRESS, id, answer.seed, nonce, r.pendingCell, r.level, r.bones);
      this.liftLock = false;
      this.settle({ level: r.level, cell: r.pendingCell, nonce, seed: answer.seed, bone });
      if (bone) {
        try {
          const h = await this.sendFromSession("reveal", [id, answer.seed]);
          await pc.waitForTransactionReceipt({ hash: h });
        } catch {
          /* already settled */
        }
      }
    } catch (e) {
      this.set({ busy: null, error: errorText(e), phase: this.state.phase === "lifting" ? "live" : this.state.phase });
    }
  }

  /** The block the round started in, from its RoundStarted event; falls back to a recent window. */
  private async roundStartBlock(id: bigint): Promise<bigint> {
    const pc = this.publicClient!;
    const head = await pc.getBlockNumber();
    const from = head > 200_000n ? head - 200_000n : 0n;
    try {
      const logs = await pc.getLogs({
        address: CLUCKR_ADDRESS!,
        event: parseAbiItem("event RoundStarted(uint256 indexed id, address indexed player, address operator, uint256 bet, uint8 bones, bytes32 tip, uint256 reserved, uint256 burned)"),
        args: { id },
        fromBlock: from,
      });
      if (logs.length) return logs[0].blockNumber;
    } catch {
      /* provider without log filters: scan the window */
    }
    return from;
  }

  /** On connect: pick up the wallet's live round, if any. */
  async resume(): Promise<void> {
    const pc = this.publicClient;
    const account = this.account;
    if (!pc || !account || !CLUCKR_ADDRESS) return;
    if (this.state.phase !== "idle" || this.state.mode !== "live") return;
    try {
      const id = await pc.readContract({ address: CLUCKR_ADDRESS, abi: cluckrAbi, functionName: "roundOf", args: [account] });
      if (id !== 0n) await this.loadRound(id);
    } catch (e) {
      this.set({ error: errorText(e) });
    }
  }

  // ── practice bookkeeping ───────────────────────────────────────────

  private recordPractice(lifts: Lift[], busted: boolean, payout: bigint, level = this.state.level): void {
    const s = this.state;
    const p = PRACTICE_PARAMS;
    const entry: HistoryEntry = {
      id: `p${s.roundId}`,
      player: "you",
      bones: s.bones,
      level,
      multiplier: busted ? 0 : multiplierAt(s.bones, level, p.edgeBps),
      payout,
      bet: s.bet,
      busted,
      at: Date.now(),
    };
    let balance = s.practiceBalance;
    if (balance < 10n ** 18n) {
      balance = PRACTICE_START;
      savePracticeBalance(balance);
    }
    this.set({ practiceHistory: [entry, ...s.practiceHistory].slice(0, 30), practiceBalance: balance });
  }

  private fail(message: string): void {
    this.set({ error: message });
  }
}

export const game = new Game();
