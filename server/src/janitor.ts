import { config } from "./config.ts";
import { Status, chainNow, nextRoundId, readParams, readRound, sendExpire, sendReveal } from "./chain.ts";
import { bindChainToRound, getChain, liveRounds, meta, putMeta, purgeExpiredChains, saveRound } from "./db.ts";
import { pendingSeed } from "./house.ts";

/**
 * Sweeps the table. Every `janitorSeconds` it:
 *   1. picks up rounds started since the last sweep and remembers the
 *      ones whose commitment came from this house;
 *   2. for a live round whose lift has sat unsettled for
 *      `revealAfterSeconds`, posts the seed on chain (a bone the player
 *      would rather not settle, or a player who walked away);
 *   3. for a live round idle past `idleTimeout`, calls `expire`, which
 *      pays the player their standing and frees the reserve.
 * Every transaction it sends is one the contract lets anyone send.
 */

let sweeping = false;
let timer: NodeJS.Timeout | null = null;

export const janitorLog: string[] = [];
function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}`;
  janitorLog.push(stamped);
  if (janitorLog.length > 200) janitorLog.shift();
  console.log(`[janitor] ${line}`);
}

async function pickUpNewRounds(): Promise<void> {
  const next = await nextRoundId();
  let last = Number(meta("last_round_seen") ?? 0);
  while (last + 1 < next) {
    const id = last + 1;
    const r = await readRound(id);
    const chain = getChain(r.tip);
    if (chain) {
      if (chain.round_id === null) bindChainToRound(r.tip, id);
      saveRound({ id, tip: r.tip, player: r.player, status: r.status, level: r.level, pending: r.pending ? 1 : 0 });
    }
    last = id;
    putMeta("last_round_seen", String(last));
  }
}

export async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    purgeExpiredChains();
    await pickUpNewRounds();
    const params = await readParams();
    const now = await chainNow();
    for (const row of liveRounds()) {
      const r = await readRound(row.id);
      saveRound({ id: row.id, tip: r.tip, player: r.player, status: r.status, level: r.level, pending: r.pending ? 1 : 0 });
      if (r.status !== Status.Live) continue;

      if (r.pending) {
        const waited = now - r.pendingAt;
        if (waited >= config.revealAfterSeconds && config.janitor) {
          const seed = pendingSeed(r);
          if (!seed) {
            log(`round ${row.id}: pending lift but no seed on file — cannot settle`);
            continue;
          }
          try {
            const hash = await sendReveal(row.id, seed);
            const after = await readRound(row.id);
            log(`round ${row.id}: settled lift ${r.level} after ${waited}s → ${after.status === Status.Busted ? "bone" : "chicken"} (${hash})`);
            saveRound({ id: row.id, tip: after.tip, player: after.player, status: after.status, level: after.level, pending: after.pending ? 1 : 0 });
          } catch (e) {
            // The player's own transaction usually lands first; the revert is the expected loss of the race.
            log(`round ${row.id}: reveal failed — ${(e as Error).message.split("\n")[0]}`);
          }
        }
        continue;
      }

      const idle = now - r.lastActionAt;
      if (idle >= params.idleTimeout && config.janitor) {
        try {
          const hash = await sendExpire(row.id);
          log(`round ${row.id}: expired after ${idle}s idle at level ${r.level} (${hash})`);
          const after = await readRound(row.id);
          saveRound({ id: row.id, tip: after.tip, player: after.player, status: after.status, level: after.level, pending: after.pending ? 1 : 0 });
        } catch (e) {
          log(`round ${row.id}: expire failed — ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
  } catch (e) {
    log(`sweep failed — ${(e as Error).message.split("\n")[0]}`);
  } finally {
    sweeping = false;
  }
}

export function startJanitor(): void {
  if (timer) return;
  void sweep();
  timer = setInterval(() => void sweep(), config.janitorSeconds * 1000);
}

export function stopJanitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
