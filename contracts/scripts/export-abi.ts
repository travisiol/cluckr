import hre from "hardhat";
import { exportAbis, frontendAbiDir } from "./lib/exportAbi";

async function main() {
  await hre.run("compile", { quiet: true });
  await exportAbis(hre);
  console.log(`ABIs written to ${frontendAbiDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
