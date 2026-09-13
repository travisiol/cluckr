import { getAddress, isAddress, type Hex } from "viem";
import { cluckrAbi } from "@/lib/abi/Cluckr";

/**
 * Where the table is. Both addresses come from the environment; without
 * them the site runs the practice table only and says so. The variables
 * are referenced by their full static name: Next only inlines
 * `process.env.NEXT_PUBLIC_*` when it can see the name at build time.
 */
function addr(v: string | undefined): Hex | null {
  const t = v?.trim();
  return t && isAddress(t) ? getAddress(t) : null;
}

export const CLUCKR_ADDRESS = addr(process.env.NEXT_PUBLIC_CLUCKR_ADDRESS);
export const TOKEN_ADDRESS = addr(process.env.NEXT_PUBLIC_TOKEN_ADDRESS);
/** The house: hands out commitments and reveals seeds. */
export const HOUSE_URL = (process.env.NEXT_PUBLIC_HOUSE_URL ?? "http://localhost:8795").replace(/\/$/, "");
/** Where the token is traded (Pons V2 on Robinhood Chain), if anywhere yet. */
export const TRADE_URL = process.env.NEXT_PUBLIC_TRADE_URL?.trim() || null;

export const isLive = CLUCKR_ADDRESS !== null && TOKEN_ADDRESS !== null;

export { cluckrAbi };

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const Status = { None: 0, Live: 1, Cashed: 2, Busted: 3, Expired: 4 } as const;
