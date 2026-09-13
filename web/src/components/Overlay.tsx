"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { CLUCKR_ADDRESS, HOUSE_URL, TOKEN_ADDRESS, TRADE_URL } from "@/lib/contracts";
import { explorer, chain } from "@/lib/chain";
import { verifyRound } from "@/lib/fair";
import { game, type GameState, type TableParams } from "@/lib/game";
import { cellName, fmtEth, fmtToken, shortAddress } from "@/lib/format";
import { forgetSession, loadSession, returnGas, type Session } from "@/lib/session";
import { site } from "@/lib/site";
import type { Coop } from "@/lib/useTable";

export type Tab = "how" | "fair" | "coop" | "session";

export const TABS: { id: Tab; label: string }[] = [
  { id: "how", label: "How it works" },
  { id: "fair", label: "Provably fair" },
  { id: "coop", label: "The coop" },
  { id: "session", label: "Session key" },
];

export function Overlay({
  tab,
  onClose,
  onTab,
  state,
  params,
  coop,
}: {
  tab: Tab | null;
  onClose: () => void;
  onTab: (t: Tab) => void;
  state: GameState;
  params: TableParams;
  coop: Coop | null;
}) {
  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, onClose]);

  if (!tab) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-3 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose} role="presentation">
      <div
        className="glass banner flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={TABS.find((t) => t.id === tab)?.label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <div className="seg">
            {TABS.map((t) => (
              <button key={t.id} type="button" aria-pressed={t.id === tab} onClick={() => onTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-glass btn-sm ml-auto" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto px-5 py-5 text-[13.5px] leading-relaxed text-ink-2">
          {tab === "how" ? <How params={params} /> : null}
          {tab === "fair" ? <Fair state={state} /> : null}
          {tab === "coop" ? <CoopTab coop={coop} params={params} /> : null}
          {tab === "session" ? <SessionTab /> : null}
        </div>
      </div>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="display mb-2 mt-6 text-[1.35rem] text-ink first:mt-0">{children}</h3>;
}

function How({ params }: { params: TableParams }) {
  return (
    <div>
      <H>Twenty-five cloches. Some hide a bone.</H>
      <p>
        Put {site.ticker} on the table and choose how many bones are hidden among the 25 cloches: one to twenty-four. Lift cloches one at a time. A roast
        chicken multiplies your bet; the first bone kills the round and the bet stays on the table. Cash out whenever you like — after one chicken or after
        twenty.
      </p>
      <H>The ladder</H>
      <p>
        With <span className="num">k</span> bones, after <span className="num">n</span> chickens the bet is worth{" "}
        <span className="num">(1 − {(params.edgeBps / 100).toFixed(0)}%) × C(25, n) / C(25 − k, n)</span>: exactly the odds of drawing n chickens in a row,
        minus the house edge. Three bones pay ×1.11 on the first lift and ×4.95 after ten; twenty-four bones pay ×24.5 on the one cloche that is not a bone.
        The whole ladder is on the right before you bet.
      </p>
      <H>What burns</H>
      <p>
        {params.burnBps > 0
          ? `${(params.burnBps / 100).toFixed(params.burnBps % 100 ? 1 : 0)}% of every bet is sent to the boneyard (0x…dEaD) on the way in and never comes back. Win or lose, the table shrinks the supply.`
          : "Nothing is burned on this table."}
      </p>
      <H>The coop</H>
      <p>
        The coop is the token the game contract holds: it pays the winners and keeps the losers&apos; bets. No round may win more than{" "}
        {(params.maxPayoutBps / 100).toFixed(0)}% of the coop that is not already promised to other live rounds — that cap is fixed when your round starts,
        shown as &ldquo;most this round pays&rdquo;, and rungs above it are marked. The money a live round could win is reserved until it ends; the owner
        cannot withdraw it.
      </p>
      <H>Two timers</H>
      <p>
        If the house does not reveal a lift within {Math.round(params.revealTimeout / 60)} minutes, you may take that lift as a chicken and cash out. If a
        round sits untouched for {Math.round(params.idleTimeout / 60)} minutes, anyone may close it and it pays you its standing (the bet back if you never
        lifted). Nothing can stay stuck.
      </p>
    </div>
  );
}

function Fair({ state }: { state: GameState }) {
  const [result, setResult] = useState<{ ok: boolean; failures: string[] } | null>(null);
  const live = state.mode === "live";
  const canVerify = state.tip !== null && state.lifts.length > 0 && (live ? CLUCKR_ADDRESS !== null : true);
  const run = () => {
    if (!state.tip || state.roundId === null) return;
    const house = live ? CLUCKR_ADDRESS! : "0x00000000000000000000000000000000000c1ac7";
    setResult(verifyRound(house, state.roundId, state.tip, state.lifts, state.bones));
  };
  return (
    <div>
      <H>Neither side can steer a lift.</H>
      <p>
        Before a round, the house signs the top of a hash chain: <span className="num">tip = H(s₁)</span>, <span className="num">s₁ = H(s₂)</span>, and so on,
        twenty-five seeds only the house knows. Each lift you make goes on chain with a nonce your browser draws at random. The house then reveals the next
        seed; the contract accepts it only if it hashes to the commitment it holds, and rolls{" "}
        <span className="num">keccak(seed, nonce, cloche, round, contract) mod (cloches left) &lt; bones</span>.
      </p>
      <p className="mt-3">
        The house committed to every seed before your first lift and cannot know your nonce. You cannot know the seed. If the house stays silent, the
        contract pays you as if the lift were a chicken — silence never pays the house.
      </p>

      <H>{live ? `Round #${state.roundId ?? "—"}` : "This practice round"}</H>
      {state.tip ? (
        <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          <dt className="text-ink-3">tip</dt>
          <dd className="break-all">{state.tip}</dd>
          {live ? (
            <>
              <dt className="text-ink-3">contract</dt>
              <dd className="break-all">{CLUCKR_ADDRESS}</dd>
              <dt className="text-ink-3">house</dt>
              <dd className="break-all">{HOUSE_URL}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="text-ink-3">No round yet. Put something on the table and the commitment appears here.</p>
      )}
      {state.lifts.length ? (
        <ol className="mt-3 space-y-2">
          {state.lifts.map((l) => (
            <li key={l.level} className="rounded-xl border border-edge bg-black/30 p-3 text-[11.5px]">
              <div className="flex items-center justify-between">
                <span className="num text-ink">
                  Lift {l.level + 1} · {cellName(l.cell)}
                </span>
                <span className={`num ${l.bone ? "text-red" : "text-gold-hot"}`}>{l.bone ? "bone" : "chicken"}</span>
              </div>
              <div className="num mt-1 break-all text-ink-3">nonce {l.nonce}</div>
              <div className="num break-all text-ink-3">seed {l.seed}</div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-glass btn-sm" onClick={run} disabled={!canVerify}>
          Re-check every lift in this browser
        </button>
        {result ? (
          <span className={`num text-[12px] ${result.ok ? "text-gold-hot" : "text-red"}`}>
            {result.ok ? `${state.lifts.length} lift${state.lifts.length > 1 ? "s" : ""} check out` : result.failures.join(" · ")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CoopTab({ coop, params }: { coop: Coop | null; params: TableParams }) {
  const tokenLink = TOKEN_ADDRESS ? explorer.token(TOKEN_ADDRESS) : null;
  const contractLink = CLUCKR_ADDRESS ? explorer.address(CLUCKR_ADDRESS) : null;
  return (
    <div>
      <H>The coop is the house.</H>
      {coop ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-3">
          <Stat label="Free coop" value={`${fmtToken(coop.free, params.decimals)} ${params.symbol}`} />
          <Stat label="Reserved for live rounds" value={`${fmtToken(coop.reserved, params.decimals)} ${params.symbol}`} />
          <Stat label="Most one round may win" value={`${fmtToken(params.maxWin, params.decimals)} ${params.symbol}`} />
          <Stat label="Wagered, all time" value={`${fmtToken(coop.totalWagered, params.decimals)} ${params.symbol}`} />
          <Stat label="Paid out, all time" value={`${fmtToken(coop.totalPaid, params.decimals)} ${params.symbol}`} />
          <Stat label="Burned, all time" value={`${fmtToken(coop.totalBurned, params.decimals)} ${params.symbol}`} gold />
          <Stat label="Rounds" value={coop.roundsPlayed.toString()} />
          <Stat label="Ended on a bone" value={coop.roundsBusted.toString()} />
          <Stat label="Edge · burn · cap" value={`${params.edgeBps / 100}% · ${params.burnBps / 100}% · ${params.maxPayoutBps / 100}%`} />
        </dl>
      ) : (
        <p className="text-ink-3">No table is configured on this site yet: the practice coop is imaginary and pays play money.</p>
      )}
      <H>What the owner can and cannot do</H>
      <p>
        The owner can add to the coop, withdraw what is not reserved for live rounds, pause new rounds, change the edge, the burn and the cap, and rotate
        the house key. The owner cannot touch money reserved for a live round, cannot change a round&apos;s ladder once it started, and cannot pick a seed
        after seeing your lift. Read the contract; it is short.
      </p>
      <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-ink-3">chain</dt>
        <dd>
          {chain.name} · {chain.id}
        </dd>
        <dt className="text-ink-3">game</dt>
        <dd className="break-all">{CLUCKR_ADDRESS ? contractLink ? <a className="underline" href={contractLink} target="_blank" rel="noreferrer">{CLUCKR_ADDRESS}</a> : CLUCKR_ADDRESS : "not deployed on this site"}</dd>
        <dt className="text-ink-3">token</dt>
        <dd className="break-all">{TOKEN_ADDRESS ? tokenLink ? <a className="underline" href={tokenLink} target="_blank" rel="noreferrer">{TOKEN_ADDRESS}</a> : TOKEN_ADDRESS : "—"}</dd>
        {TRADE_URL ? (
          <>
            <dt className="text-ink-3">trade</dt>
            <dd>
              <a className="underline" href={TRADE_URL} target="_blank" rel="noreferrer">
                {TRADE_URL}
              </a>
            </dd>
          </>
        ) : null}
        {coop?.house ? (
          <>
            <dt className="text-ink-3">house key</dt>
            <dd className="break-all">{coop.house}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function Stat({ label, value, gold = false }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="rounded-xl border border-edge bg-black/30 p-3">
      <div className="label">{label}</div>
      <div className={`num mt-1 text-[13px] ${gold ? "text-gold-hot" : "text-ink"}`}>{value}</div>
    </div>
  );
}

function SessionTab() {
  const client = usePublicClient();
  const { address } = useAccount();
  // The overlay only ever renders on the client, after a click: no hydration to match.
  const [session, setSession] = useState<Session | null>(() => (typeof window === "undefined" ? null : loadSession()));
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !client) return;
    let cancelled = false;
    client
      .getBalance({ address: session.address })
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session, busy]);

  const give = async () => {
    if (!session || !client || !address) return;
    setBusy("Returning gas…");
    setNote(null);
    try {
      const hash = await returnGas(session, client, address);
      setNote(hash ? `Sent back. ${explorer.tx(hash) ?? hash}` : "Nothing left to return.");
    } catch (e) {
      setNote((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  };

  const forget = () => {
    forgetSession();
    setSession(null);
    setBalance(null);
    setNote("Forgotten. The next round makes a new one.");
  };

  const busyRound = game.getState().phase !== "idle" && game.getState().phase !== "busted" && game.getState().phase !== "cashed";

  return (
    <div>
      <H>One prompt per round, not per cloche.</H>
      <p>
        Your first round names a throwaway key kept in this browser as the round&apos;s operator, and sends it a little ETH for gas. Every lift and the
        cash-out are then transactions that key signs itself. It can only lift and cash out — the contract pays your wallet, never the key — and it holds gas
        money and nothing else.
      </p>
      <p className="mt-3">
        Someone who copied this browser&apos;s storage could lift cloches or cash out on your live round, to your wallet. They could not take your tokens.
        Clear it whenever you like.
      </p>
      <H>This browser&apos;s key</H>
      {session ? (
        <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          <dt className="text-ink-3">address</dt>
          <dd className="break-all">{session.address}</dd>
          <dt className="text-ink-3">gas money</dt>
          <dd>{balance === null ? "…" : `${fmtEth(balance)} ETH`}</dd>
        </dl>
      ) : (
        <p className="text-ink-3">None yet. The first real round creates one.</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-glass btn-sm" onClick={() => void give()} disabled={!session || !address || busy !== null || busyRound}>
          {busy ?? "Return the gas to my wallet"}
        </button>
        <button type="button" className="btn btn-glass btn-sm" onClick={forget} disabled={!session || busyRound}>
          Forget this key
        </button>
      </div>
      {busyRound ? <p className="mt-2 text-[12px] text-ink-3">Finish the live round first.</p> : null}
      {note ? <p className="num mt-2 break-all text-[12px] text-ink-3">{note}</p> : null}
      {address ? <p className="mt-3 text-[12px] text-ink-3">Wallet: {shortAddress(address)}</p> : null}
    </div>
  );
}
