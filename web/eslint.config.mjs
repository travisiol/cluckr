import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // contracts/ is its own package (Hardhat, mocha, ethers) with its own config.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "contracts/**"]),
]);

export default eslintConfig;
