import { defineChain } from "viem";

/**
 * Robinhood Chain (Arbitrum Orbit), chain id 4663, unless the environment
 * points the site at a local hardhat node (chain id 31337) for the
 * rehearsal table.
 */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === 31337 ? "http://127.0.0.1:8547" : "https://rpc.mainnet.chain.robinhood.com");

export const EXPLORER_URL = (process.env.NEXT_PUBLIC_EXPLORER_URL ?? (CHAIN_ID === 31337 ? "" : "https://robinhoodchain.blockscout.com")).replace(/\/$/, "");

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 4663 ? "Robinhood Chain" : CHAIN_ID === 31337 ? "Local table (hardhat)" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  ...(EXPLORER_URL ? { blockExplorers: { default: { name: "Explorer", url: EXPLORER_URL } } } : {}),
  testnet: CHAIN_ID !== 4663,
});

export const explorer = {
  address: (a: string) => (EXPLORER_URL ? `${EXPLORER_URL}/address/${a}` : null),
  tx: (h: string) => (EXPLORER_URL ? `${EXPLORER_URL}/tx/${h}` : null),
  token: (a: string) => (EXPLORER_URL ? `${EXPLORER_URL}/token/${a}` : null),
};
