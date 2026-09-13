import * as fs from "fs";
import * as path from "path";
import { ethers, network } from "hardhat";
import { deploymentsDir, type DeploymentRecord } from "./lib/exportAbi";

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function isLocal(): boolean {
  return network.name === "hardhat" || network.name === "localhost";
}

/**
 * Deploys the table.
 *
 *   TOKEN_ADDRESS      the token played with (a MockToken is deployed locally when unset)
 *   HOUSE_ADDRESS      the house key that signs commitments (the 2nd local account when unset)
 *   OWNER_ADDRESS      final owner, accepted via Ownable2Step (defaults to the deployer)
 *   FUND_TOKENS        whole tokens moved into the coop right away ("0" to skip; 1,000,000 locally)
 *   EDGE_BPS           house edge, 200
 *   BURN_BPS           slice of every bet burned, 100
 *   MAX_PAYOUT_BPS     most one round may win, in bps of the free coop, 500
 *   REVEAL_TIMEOUT     seconds the house has to reveal, 600
 *   IDLE_TIMEOUT       seconds before anyone may close an idle round, 3600
 *   MIN_BET / MAX_BET  whole tokens, 1 and 1,000,000
 */
async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const owner = env("OWNER_ADDRESS") ?? deployer.address;

  console.log(`Network   : ${network.name} (chainId ${chainId})`);
  console.log(`Deployer  : ${deployer.address}`);

  let tokenAddress = env("TOKEN_ADDRESS");
  let decimals = 18;
  if (!tokenAddress) {
    if (!isLocal()) throw new Error("TOKEN_ADDRESS is required on this network.");
    const token = await (await ethers.getContractFactory("MockToken")).deploy("Cluck", "CLUCK");
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    // Everyone at the local table gets a stack to play with.
    for (const s of signers.slice(0, 6)) {
      await (await token.mint(s.address, ethers.parseEther("10000000"))).wait();
    }
    console.log(`MockToken : ${tokenAddress} (10,000,000 CLUCK minted to the first six accounts)`);
  } else {
    const erc = await ethers.getContractAt("MockToken", tokenAddress);
    decimals = Number(await erc.decimals());
  }
  const unit = 10n ** BigInt(decimals);

  let house = env("HOUSE_ADDRESS");
  if (!house) {
    if (!isLocal()) throw new Error("HOUSE_ADDRESS is required on this network.");
    house = signers[1].address;
  }
  console.log(`House     : ${house}`);
  console.log(`Owner     : ${owner}`);

  const params = {
    edgeBps: Number(env("EDGE_BPS") ?? 200),
    burnBps: Number(env("BURN_BPS") ?? 100),
    maxPayoutBps: Number(env("MAX_PAYOUT_BPS") ?? 500),
    revealTimeout: Number(env("REVEAL_TIMEOUT") ?? 600),
    idleTimeout: Number(env("IDLE_TIMEOUT") ?? 3600),
    minBet: BigInt(env("MIN_BET") ?? 1) * unit,
    maxBet: BigInt(env("MAX_BET") ?? 1_000_000) * unit,
  };

  const cluckr = await (await ethers.getContractFactory("Cluckr")).deploy(tokenAddress, house, deployer.address, params);
  const receipt = await cluckr.deploymentTransaction()?.wait();
  await cluckr.waitForDeployment();
  const cluckrAddress = await cluckr.getAddress();
  console.log(`Cluckr    : ${cluckrAddress}`);

  const fundTokens = BigInt(env("FUND_TOKENS") ?? (isLocal() ? 1_000_000 : 0));
  let funded = 0n;
  if (fundTokens > 0n) {
    const token = await ethers.getContractAt("MockToken", tokenAddress);
    funded = fundTokens * unit;
    await (await token.approve(cluckrAddress, funded)).wait();
    await (await cluckr.fund(funded)).wait();
    console.log(`Coop      : funded with ${fundTokens.toString()} tokens`);
  }

  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await cluckr.transferOwnership(owner)).wait();
    console.log(`Ownership offered to ${owner} — call acceptOwnership() from that account.`);
  }

  const record: DeploymentRecord = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    owner,
    house,
    token: tokenAddress,
    cluckr: cluckrAddress,
    params: {
      edgeBps: params.edgeBps,
      burnBps: params.burnBps,
      maxPayoutBps: params.maxPayoutBps,
      revealTimeout: params.revealTimeout,
      idleTimeout: params.idleTimeout,
      minBet: params.minBet.toString(),
      maxBet: params.maxBet.toString(),
    },
    fundedWei: funded.toString(),
    deployedAt: new Date().toISOString(),
    txHash: receipt?.hash ?? null,
  };
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const file = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Saved ${file}`);
  console.log(`\nHouse : CLUCKR_ADDRESS=${cluckrAddress}`);
  console.log(`Web   : NEXT_PUBLIC_CLUCKR_ADDRESS=${cluckrAddress} NEXT_PUBLIC_TOKEN_ADDRESS=${tokenAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
