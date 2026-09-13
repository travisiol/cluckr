# CLUCKR — Lift the cloche. Cluck or die.

Twenty-five chrome cloches on a table. Some hide a roast chicken, some hide a bone. You put the token on the table, choose how many bones are hidden (1–24), and lift cloches one at a time. Every chicken multiplies the bet; the first bone kills the round. Cash out whenever you like.

Three packages, no workspaces:

| folder       | what it is                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `contracts/` | `Cluckr.sol` — the table and the coop (bankroll). Hardhat 2, OpenZeppelin 5, Solidity 0.8.28. 36 tests.        |
| `server/`    | the house — signs hash-chain commitments, reveals one seed per lift, sweeps abandoned rounds. Node 24, SQLite. |
| `web/`       | the game — Next 16, wagmi/viem, three.js. One screen: the board is the page.                                   |

## How a round works

1. **Commit.** The browser asks the house for a commitment: the top of a hash chain `tip = H(s₁)`, `s₁ = H(s₂)`, … (25 seeds only the house knows), signed by the house key for this player, with an expiry.
2. **Start.** One wallet transaction: `startRound(amount, bones, tip, expiry, signature, sessionKey)`. The burn slice goes to `0x…dEaD`, the rest is the stake, and the contract reserves the most the round can win from the coop. Any ETH sent along is forwarded to the session key as gas money.
3. **Lift.** Each lift is `pick(id, cell, nonce, prevSeed)`, signed by the session key in the browser (no wallet prompt). The nonce is random; `prevSeed` settles the previous lift.
4. **Reveal.** The house answers `GET /reveal/:id/:level` only once the lift is on chain. The browser hashes the seed against the commitment before it trusts it, rolls `keccak(seed, nonce, cell, id, contract) mod (cloches left) < bones`, and shows the chicken or the bone. The seed rides in the next transaction; a bone is settled on chain right away.
5. **Cash out.** `cashout(id, prevSeed)` pays `bet × (1 − edge) × C(25, n) / C(25 − bones, n)`, capped at the round's reserve.

Neither side can steer a lift: the house committed to every seed before the first lift and cannot know the nonce; the player cannot know the seed. The house's only move is silence, and silence pays the player (`forceCashout` after `revealTimeout` counts the lift as a chicken). A round nobody touches for `idleTimeout` can be closed by anyone at its standing (`expire`).

## Economics (defaults, all owner-settable)

| parameter      | default            | what it does                                                             |
| -------------- | ------------------ | ------------------------------------------------------------------------ |
| `edgeBps`      | 200 (2 %)          | taken out of every multiplier                                            |
| `burnBps`      | 100 (1 %)          | slice of every bet sent to the boneyard on the way in                    |
| `maxPayoutBps` | 500 (5 %)          | most one round may win, as a share of the coop not reserved by others    |
| `revealTimeout`| 600 s              | how long the house has to reveal a lift                                  |
| `idleTimeout`  | 3600 s             | silence after which anyone may close a round at its standing             |
| `minBet/maxBet`| 1 / 1,000,000      | in whole tokens                                                          |

With 3 bones the first lift pays ×1.11 and the tenth ×4.95; with 24 bones the one safe cloche pays ×24.5. The full ladder is in `web/src/lib/ladder.ts`, and the contract's `ladder(bet, bones)` view returns the same numbers.

## Run it locally (the rehearsal table)

```bash
cd contracts && npm ci && npm test                 # 36 tests
npm run node                                       # hardhat on :8547, in its own terminal
npm run deploy:local                               # MockToken + Cluckr, coop funded with 1,000,000

cd ../server && npm install
RPC_URL=http://127.0.0.1:8547 CHAIN_ID=31337 CLUCKR_ADDRESS=<from deploy> \
HOUSE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
npm run start                                      # the house on :8795 (hardhat account #1 is the default house)
npm run e2e                                        # 29 checks against the running node

cd ../web && npm ci
# .env.local: NEXT_PUBLIC_CHAIN_ID=31337, NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8547,
#             NEXT_PUBLIC_CLUCKR_ADDRESS / NEXT_PUBLIC_TOKEN_ADDRESS from the deploy, NEXT_PUBLIC_GAS_STIPEND_ETH=0.05
npm run dev -- --port 3130
```

Without `NEXT_PUBLIC_CLUCKR_ADDRESS` the site runs the practice table only: play money, the browser is its own house, same maths.

## Go live on Robinhood Chain

1. Have the token (any ERC-20; a Pons V2 launch works, the coop counts what actually arrives).
2. `contracts/.env`: `DEPLOYER_PRIVATE_KEY`, then `TOKEN_ADDRESS=… HOUSE_ADDRESS=… FUND_TOKENS=… npm run deploy:robinhood`. The record lands in `contracts/deployments/robinhood.json`.
3. `server/.env`: `CLUCKR_ADDRESS`, `HOUSE_KEY` (the key behind `HOUSE_ADDRESS`, with a little ETH for the janitor), `ORIGIN=https://your.site`. Run it somewhere that stays up; back up `data/house.sqlite` — it holds every unrevealed seed.
4. `web/.env`: `NEXT_PUBLIC_CLUCKR_ADDRESS`, `NEXT_PUBLIC_TOKEN_ADDRESS`, `NEXT_PUBLIC_HOUSE_URL`, `NEXT_PUBLIC_TRADE_URL`. `npm run build`.

## Trust, stated plainly

- The owner can withdraw the **free** coop, pause new rounds, change the parameters and rotate the house key. The owner cannot touch what live rounds could win, cannot change a round's ladder after it started, and cannot pick a seed after seeing a lift.
- The house key signs commitments and pays for the janitor's transactions. If its database is lost, every live round ends in a forced cash-out in the player's favour. If it leaks, a player can read the table. Keep it in a KMS in production.
- The session key in the browser can only lift and cash out on your own round; the contract pays the player's wallet, never the key. It holds gas money and gives it back on request (Session key tab).
- Not audited. The contract is short; read it.
