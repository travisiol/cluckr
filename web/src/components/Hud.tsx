"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { game, type GameState, type TableParams } from "@/lib/game";
import { bustChance, multiplierAt, netBet, payoutAt, reserveFor } from "@/lib/ladder";
import { cellName, fmtMult, fmtPct, fmtToken } from "@/lib/format";
import { CELLS } from "@/lib/site";

const PRESETS = [1, 3, 5, 10, 24];

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * The left-hand glass: bet and bones before a round, the multiplier and
 * the cash-out during one, the verdict after. One panel, three faces.
 */
export function Hud({ state, params, balance }: { state: GameState; params: TableParams; balance: bigint | null }) {
  const { phase } = state;
  if (phase === "idle" || phase === "starting") return <Setup state={state} params={params} balance={balance} />;
  if (phase === "busted" || phase === "cashed") return <Verdict state={state} params={params} />;
  return <InRound state={state} params={params} />;
}

function Setup({ state, params, balance }: { state: GameState; params: TableParams; balance: bigint | null }) {
  const { amount, bones, mode, error, busy, phase } = state;
  const [text, setText] = useState(() => formatUnits(amount, params.decimals));
  // The field follows the store when the amount changes from outside (the
  // ½ / ×2 / max buttons, hydration), without an effect.
  const [synced, setSynced] = useState(amount);
  if (synced !== amount) {
    setSynced(amount);
    setText(formatUnits(amount, params.decimals));
  }

  const bet = netBet(amount, params.burnBps);
  const reserve = reserveFor(bet, bones, params.edgeBps, params.maxWin);
  const first = multiplierAt(bones, 1, params.edgeBps);
  const topLevel = CELLS - bones;
  const top = payoutAt(bet, bones, topLevel, params.edgeBps);
  const topCapped = top > reserve;
  const burn = amount - bet;
  const busyNow = phase === "starting";
  const available = mode === "practice" ? state.practiceBalance : balance;

  const commit = (raw: string) => {
    setText(raw);
    const cleaned = raw.replace(/,/g, "").trim();
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return;
    try {
      game.setAmount(parseUnits(cleaned, params.decimals));
    } catch {
      /* more decimals than the token has; keep the last good value */
    }
  };
  const setAmount = (v: bigint) => {
    game.setAmount(v);
    setText(formatUnits(v, params.decimals));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="label">{mode === "practice" ? "Play money" : "Your stack"}</span>
        <span className="num text-sm text-ink-2">
          {available === null ? "—" : fmtToken(available, params.decimals)} {params.symbol}
        </span>
      </div>

      <label className="block">
        <span className="label">Bet</span>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            className="field text-lg"
            inputMode="decimal"
            value={text}
            onChange={(e) => commit(e.target.value)}
            disabled={busyNow}
            aria-label={`Bet in ${params.symbol}`}
          />
          <div className="seg shrink-0">
            <button type="button" onClick={() => setAmount(amount / 2n > 0n ? amount / 2n : amount)} disabled={busyNow}>
              ½
            </button>
            <button type="button" onClick={() => setAmount(amount * 2n)} disabled={busyNow}>
              ×2
            </button>
            <button type="button" onClick={() => available !== null && setAmount(available < params.maxBet ? available : params.maxBet)} disabled={busyNow || available === null}>
              max
            </button>
          </div>
        </div>
        <div className="mt-1.5 text-[11px] text-ink-3">
          {params.burnBps > 0 ? (
            <>
              {fmtToken(burn, params.decimals)} {params.symbol} burns on the way in · {fmtToken(bet, params.decimals)} goes on the table
            </>
          ) : (
            <>Nothing burns on the way in</>
          )}
        </div>
      </label>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="label">Bones on the table</span>
          <span className="num text-sm text-ink">
            {bones} <span className="text-ink-3">/ 25 cloches</span>
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={24}
          value={bones}
          onChange={(e) => game.setBones(Number(e.target.value))}
          className="slider mt-3"
          style={{ ["--fill" as string]: `${((bones - 1) / 23) * 100}%` }}
          aria-label="Bones on the table"
          disabled={busyNow}
        />
        <div className="seg mt-3 w-full justify-between">
          {PRESETS.map((p) => (
            <button key={p} type="button" aria-pressed={bones === p} onClick={() => game.setBones(p)} disabled={busyNow}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-ink-3">First lift</dt>
        <dd className="num text-right text-ink">
          {fmtMult(first)} <span className="text-ink-3">· {fmtPct(bustChance(bones, 0), 0)} bust</span>
        </dd>
        <dt className="text-ink-3">Top of the ladder</dt>
        <dd className="num text-right text-ink">
          {fmtMult(multiplierAt(bones, topLevel, params.edgeBps))} <span className="text-ink-3">· {topLevel} lifts</span>
        </dd>
        <dt className="text-ink-3">Most this round pays</dt>
        <dd className={`num text-right ${topCapped ? "text-gold" : "text-ink"}`}>
          {fmtToken(reserve, params.decimals)} {params.symbol}
          {topCapped ? <span className="text-ink-3"> · coop cap</span> : null}
        </dd>
      </dl>

      <button type="button" className="btn btn-gold w-full text-base" onClick={() => void game.start()} disabled={busyNow || amount === 0n}>
        {busyNow ? busy ?? "Working…" : `Put ${fmtToken(amount, params.decimals)} ${params.symbol} on the table`}
      </button>

      {mode === "live" ? (
        <p className="text-[11px] leading-relaxed text-ink-3">
          One wallet prompt per round. The lifts are signed by a session key in this browser, which gets a little gas money with the first round and hands it back on request.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-ink-3">Practice table: play money, the browser is its own house. Connect a wallet to play the real one.</p>
      )}

      {error ? <ErrorLine text={error} /> : null}
    </div>
  );
}

function InRound({ state, params }: { state: GameState; params: TableParams }) {
  const { bet, bones, level, phase, busy, error, pendingCell, pendingSince, mode } = state;
  const now = useNow(phase === "lifting" && mode === "live");
  const currentMult = multiplierAt(bones, level, params.edgeBps);
  const current = level === 0 ? 0n : capPayout(payoutAt(bet, bones, level, params.edgeBps), state.reserve);
  const nextLevel = level + 1;
  const canLiftMore = level < CELLS - bones;
  const next = canLiftMore ? capPayout(payoutAt(bet, bones, nextLevel, params.edgeBps), state.reserve) : null;
  const lifting = phase === "lifting";
  const cashing = phase === "cashing";
  const houseLate = lifting && mode === "live" && pendingSince !== null && now >= pendingSince + params.revealTimeout;
  const remaining = CELLS - level;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="label">{mode === "practice" ? "Practice round" : `Round #${state.roundId}`}</span>
        <span className="num whitespace-nowrap text-[12px] text-ink-3">
          {bones} bones · {remaining - bones} chickens
        </span>
      </div>

      <div className="rounded-2xl border border-edge bg-black/30 p-4">
        <div className="label">Standing</div>
        <div className={`display mt-1 text-[2.6rem] ${level > 0 ? "text-gold-hot" : "text-ink-3"}`}>{level === 0 ? "×—" : fmtMult(currentMult)}</div>
        <div className="num mt-1 text-sm text-ink-2">
          {level === 0 ? `${fmtToken(bet, params.decimals)} ${params.symbol} on the table` : `${fmtToken(current, params.decimals)} ${params.symbol} if you cash out now`}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-ink-3">Next lift</dt>
        <dd className="num text-right text-ink">
          {next !== null ? (
            <>
              {fmtMult(multiplierAt(bones, nextLevel, params.edgeBps))} <span className="text-ink-3">· {fmtToken(next, params.decimals)}</span>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-ink-3">Chance of a bone</dt>
        <dd className={`num text-right ${bustChance(bones, level) >= 0.5 ? "text-red" : "text-ink"}`}>{fmtPct(bustChance(bones, level))}</dd>
      </dl>

      <button
        type="button"
        className={`btn btn-gold w-full text-base ${level > 0 && !lifting && !cashing ? "pulse-gold" : ""}`}
        onClick={() => void game.cashout()}
        disabled={level === 0 || lifting || cashing}
      >
        {cashing ? busy ?? "Cashing out…" : level === 0 ? "Lift a cloche first" : `Cash out ${fmtToken(current, params.decimals)} ${params.symbol}`}
      </button>

      {lifting ? (
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <span className="dot bg-gold animate-pulse" />
          {pendingCell !== null ? `Lifting ${cellName(pendingCell)}… ` : ""}
          {busy ?? ""}
        </div>
      ) : (
        <p className="text-[12px] text-ink-3">Click a cloche to lift it, or take the money.</p>
      )}

      {houseLate ? (
        <div className="rounded-xl border border-red/40 bg-red-soft p-3 text-[12px] leading-relaxed">
          The house has been silent past its {Math.round(params.revealTimeout / 60)}-minute limit. You may take this lift as a chicken and leave.
          <button type="button" className="btn btn-red btn-sm mt-2 w-full" onClick={() => void game.forceCashout()}>
            Force the cash-out
          </button>
        </div>
      ) : null}

      {error ? <ErrorLine text={error} /> : null}
    </div>
  );
}

function Verdict({ state, params }: { state: GameState; params: TableParams }) {
  const { phase, bet, bones, level, payout, boneCell, forced, mode, txEnd } = state;
  const busted = phase === "busted";
  const mult = level === 0 ? 0 : multiplierAt(bones, level, params.edgeBps);
  const net = (payout ?? 0n) - bet;
  return (
    <div className="banner flex flex-col gap-4">
      {busted ? (
        <div className="rounded-2xl border border-red/40 bg-red-soft p-4">
          <div className="label text-red">Dead</div>
          <div className="display mt-1 text-[2.4rem] text-red">A bone.</div>
          <div className="num mt-1 text-sm text-ink-2">
            Under {boneCell !== null ? cellName(boneCell) : "the cloche"} · −{fmtToken(bet, params.decimals)} {params.symbol}
            {level > 0 ? ` after ${level} chicken${level > 1 ? "s" : ""}` : ""}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-gold/40 bg-gold-soft p-4">
          <div className="label text-gold">{forced ? "The house went quiet" : "Clucked out"}</div>
          <div className="display mt-1 text-[2.4rem] text-gold-hot">{fmtMult(mult)}</div>
          <div className="num mt-1 text-sm text-ink-2">
            +{fmtToken(payout ?? 0n, params.decimals)} {params.symbol}
            <span className="text-ink-3">
              {" "}
              · {net >= 0n ? "+" : "−"}
              {fmtToken(net < 0n ? -net : net, params.decimals)} net
            </span>
          </div>
        </div>
      )}
      <p className="text-[12px] text-ink-3">
        {bones} bone{bones > 1 ? "s were" : " was"} on the table.{" "}
        {busted ? "The other cloches stay down: no layout exists to reveal, only the roll you got." : "Every lift you made is listed under Provably fair."}
        {mode === "live" && txEnd ? " Settled on chain." : ""}
      </p>
      <button type="button" className="btn btn-gold w-full text-base" onClick={() => game.reset()}>
        Back to the table
      </button>
    </div>
  );
}

function capPayout(p: bigint, reserve: bigint): bigint {
  return reserve > 0n && p > reserve ? reserve : p;
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-red/40 bg-red-soft p-3 text-[12px] leading-relaxed text-ink">
      <span className="mt-1 dot shrink-0 bg-red" />
      <span className="flex-1">{text}</span>
      <button type="button" className="text-ink-3 hover:text-ink" onClick={() => game.dismissError()} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function useLadderView(state: GameState, params: TableParams) {
  return useMemo(() => ({ bet: state.bet || netBet(state.amount, params.burnBps), bones: state.bones }), [state.bet, state.amount, state.bones, params.burnBps]);
}
