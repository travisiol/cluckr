/**
 * Everything the house reads from the environment, with the defaults a
 * fresh checkout runs on. Nothing here is secret except HOUSE_KEY.
 */

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isKey = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);

export const config = {
  port: Number(env("PORT", "8795")),
  /** Where the SQLite file lives. Holds every unrevealed seed: back it up, keep it private. */
  dbPath: env("DB_PATH", "./data/house.sqlite"),
  /** Allowed browser origin. "*" in development. */
  origin: env("ORIGIN", "*"),

  // ── The chain ───────────────────────────────────────────────────────
  rpcUrl: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  chainId: Number(env("CHAIN_ID", "4663")),
  /** The Cluckr contract. */
  cluckrAddress: env("CLUCKR_ADDRESS"),
  /**
   * The house key. Signs commitments and pays for the janitor's reveals.
   * In production this belongs in a signer service or a KMS, never in a
   * file next to the game.
   */
  houseKey: env("HOUSE_KEY"),

  // ── Commitments ─────────────────────────────────────────────────────
  /** How long a signed commitment may sit unused. */
  commitMinutes: Number(env("COMMIT_MINUTES", "15")),
  /** Unused commitments a single player may hold at once. */
  commitsPerPlayer: Number(env("COMMITS_PER_PLAYER", "3")),
  /** Seeds per chain: one per possible lift (24 with one bone) and a spare. */
  chainLength: Number(env("CHAIN_LENGTH", "25")),

  // ── The janitor ─────────────────────────────────────────────────────
  /** Seconds between two sweeps of the live rounds. */
  janitorSeconds: Number(env("JANITOR_SECONDS", "15")),
  /**
   * Seconds a lift may stay unsettled before the house posts the seed on
   * chain itself. Players normally carry it in their next lift; this is
   * for players who walked away — or hit a bone and would rather not say.
   */
  revealAfterSeconds: Number(env("REVEAL_AFTER_SECONDS", "45")),
  /** Set to "false" to only answer HTTP and never send a transaction. */
  janitor: env("JANITOR", "true") !== "false",
};

export function assertConfig(): void {
  if (!isAddress(config.cluckrAddress)) throw new Error("CLUCKR_ADDRESS must be the game contract's address");
  if (!isKey(config.houseKey)) throw new Error("HOUSE_KEY must be a 32-byte hex private key");
  if (!(config.chainLength >= 25 && config.chainLength <= 64)) throw new Error("CHAIN_LENGTH must be between 25 and 64");
  if (!(config.commitMinutes >= 1)) throw new Error("COMMIT_MINUTES must be at least 1");
}
