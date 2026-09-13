import { formatUnits } from "viem";

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Token amounts: up to 2 decimals, thousands separated, never scientific. */
export function fmtToken(wei: bigint, decimals = 18, maxFraction = 2): string {
  const n = Number(formatUnits(wei, decimals));
  if (!Number.isFinite(n)) return "∞";
  if (n !== 0 && Math.abs(n) < 0.01) return n.toLocaleString("en-US", { maximumSignificantDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFraction });
}

/** Token amounts where space is short: 999,947 → "1M", 12,340 → "12.3K". */
export function fmtTokenCompact(wei: bigint, decimals = 18): string {
  const n = Number(formatUnits(wei, decimals));
  if (!Number.isFinite(n)) return "∞";
  if (Math.abs(n) < 10_000) return fmtToken(wei, decimals);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function fmtMult(m: number): string {
  if (m >= 1000) return `×${Math.round(m).toLocaleString("en-US")}`;
  if (m >= 100) return `×${m.toFixed(1)}`;
  return `×${m.toFixed(2)}`;
}

export function fmtPct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function fmtEth(wei: bigint): string {
  const n = Number(formatUnits(wei, 18));
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/** Cell index → the label a player sees ("A1" … "E5"). */
export function cellName(cell: number): string {
  return `${"ABCDE"[Math.floor(cell / 5)]}${(cell % 5) + 1}`;
}
