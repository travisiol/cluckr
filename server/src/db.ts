import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

/**
 * SQLite through Node's built-in driver: no native build step, one file on
 * disk. It holds the one thing the house must never lose or leak: the
 * seeds behind every commitment it has signed. Lose them and every live
 * round ends in a forced cash-out at the player's favour; leak them and a
 * player can read the table.
 */

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS chains (
    tip TEXT PRIMARY KEY,
    player TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    seeds TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    round_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS chains_player ON chains(player, round_id);

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY,
    tip TEXT NOT NULL,
    player TEXT NOT NULL,
    status INTEGER NOT NULL,
    level INTEGER NOT NULL,
    pending INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export interface ChainRow {
  tip: string;
  player: string;
  expiry: number;
  seeds: string[];
  round_id: number | null;
}

const insertChain = db.prepare("INSERT INTO chains (tip, player, expiry, seeds, created_at, round_id) VALUES (?, ?, ?, ?, ?, NULL)");
const selectChain = db.prepare("SELECT tip, player, expiry, seeds, round_id FROM chains WHERE tip = ?");
const countUnused = db.prepare("SELECT COUNT(*) AS n FROM chains WHERE player = ? AND round_id IS NULL AND expiry > ?");
const purgeExpired = db.prepare("DELETE FROM chains WHERE round_id IS NULL AND expiry < ?");
const bindChain = db.prepare("UPDATE chains SET round_id = ? WHERE tip = ?");

export function saveChain(tip: string, player: string, expiry: number, seeds: string[]): void {
  insertChain.run(tip, player.toLowerCase(), expiry, JSON.stringify(seeds), Math.floor(Date.now() / 1000));
}

export function getChain(tip: string): ChainRow | null {
  const row = selectChain.get(tip) as { tip: string; player: string; expiry: number; seeds: string; round_id: number | null } | undefined;
  if (!row) return null;
  return { ...row, seeds: JSON.parse(row.seeds) as string[] };
}

export function unusedChains(player: string, now: number): number {
  const row = countUnused.get(player.toLowerCase(), now) as { n: number };
  return row.n;
}

/** Drops commitments that expired without ever being used. Keeps a day of slack for clock drift. */
export function purgeExpiredChains(): number {
  return Number(purgeExpired.run(Math.floor(Date.now() / 1000) - 86_400).changes);
}

export function bindChainToRound(tip: string, roundId: number): void {
  bindChain.run(roundId, tip);
}

export interface RoundRow {
  id: number;
  tip: string;
  player: string;
  status: number;
  level: number;
  pending: number;
  updated_at: number;
}

const upsertRound = db.prepare(`
  INSERT INTO rounds (id, tip, player, status, level, pending, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = excluded.status, level = excluded.level, pending = excluded.pending, updated_at = excluded.updated_at
`);
const selectLive = db.prepare("SELECT id, tip, player, status, level, pending, updated_at FROM rounds WHERE status = 1 ORDER BY id");
const countLive = db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE status = 1");

export function saveRound(r: Omit<RoundRow, "updated_at">): void {
  upsertRound.run(r.id, r.tip, r.player.toLowerCase(), r.status, r.level, r.pending, Math.floor(Date.now() / 1000));
}

export function liveRounds(): RoundRow[] {
  return selectLive.all() as unknown as RoundRow[];
}

export function liveCount(): number {
  return (countLive.get() as { n: number }).n;
}

const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

export function meta(key: string): string | null {
  const row = getMeta.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function putMeta(key: string, value: string): void {
  setMeta.run(key, value);
}
