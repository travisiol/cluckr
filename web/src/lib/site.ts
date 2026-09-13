/**
 * Everything the brand is, in one place. Rename the game here and nowhere
 * else; the token's own name and address live in the environment.
 */
export const site = {
  name: "CLUCKR",
  tagline: "Lift the cloche. Cluck or die.",
  description:
    "25 cloches. Some hide a roast chicken, some hide a bone. Bet the token, lift them one by one, cash out before the bone. Every roll is committed by the house before you start and checked on chain.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://cluckr.fun",
  ticker: process.env.NEXT_PUBLIC_TOKEN_SYMBOL ?? "CLUCK",
  x: "https://x.com/cluckr_fun",
  keywords: ["cluckr", "chicken", "cloche", "mines", "onchain casino", "robinhood chain", "provably fair"],
} as const;

export const CELLS = 25;
export const MIN_BONES = 1;
export const MAX_BONES = 24;
