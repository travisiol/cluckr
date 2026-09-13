import { HardhatUserConfig, task } from "hardhat/config";
import { TASK_COMPILE } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import { exportAbis } from "./scripts/lib/exportAbi";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** Robinhood Chain (Arbitrum Orbit). Chain id 4663 (0x1237). */
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_CHAIN_ID = Number(process.env.ROBINHOOD_CHAIN_ID ?? 4663);

/**
 * Every successful `hardhat compile` re-exports the game ABI into
 * ../web/src/lib/abi so the front end and the house can never drift from
 * the contract. SKIP_ABI_EXPORT=true opts out.
 */
task(TASK_COMPILE, async (args, hre, runSuper) => {
  const result = await runSuper(args);
  if (process.env.SKIP_ABI_EXPORT !== "true") {
    await exportAbis(hre);
  }
  return result;
});

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.6 uses mcopy; Arbitrum Orbit chains run Cancun opcodes.
      evmVersion: process.env.SOLIDITY_EVM_VERSION ?? "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Blocks every second so a local table feels like the real chain
      // (Robinhood Chain seals one about every 110 ms).
      ...(process.env.HARDHAT_AUTOMINE === "false" ? { mining: { auto: false, interval: 1000 } } : {}),
    },
    localhost: {
      url: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8547",
    },
    robinhood: {
      url: ROBINHOOD_RPC_URL,
      chainId: ROBINHOOD_CHAIN_ID,
      accounts,
    },
  },
  etherscan: {
    apiKey: {
      robinhood: process.env.ROBINHOOD_EXPLORER_API_KEY ?? "no-key-required",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: ROBINHOOD_CHAIN_ID,
        urls: {
          apiURL: process.env.ROBINHOOD_EXPLORER_API_URL ?? "https://robinhoodchain.blockscout.com/api",
          browserURL: process.env.ROBINHOOD_EXPLORER_URL ?? "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
