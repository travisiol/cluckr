import { assertConfig, config } from "./config.ts";
import { chain, cluckr, houseAccount, onChainHouse } from "./chain.ts";
import { startHttp } from "./http.ts";
import { startJanitor } from "./janitor.ts";

assertConfig();

const server = startHttp();
console.log(`CLUCKR house on http://localhost:${config.port}`);
console.log(`  chain   ${chain.name} (${chain.id}) via ${config.rpcUrl}`);
console.log(`  cluckr  ${cluckr()}`);
console.log(`  house   ${houseAccount.address}`);

onChainHouse()
  .then((h) => {
    if (h.toLowerCase() !== houseAccount.address.toLowerCase()) {
      console.warn(`  WARNING the contract's house is ${h}; commitments signed here will be refused.`);
    } else {
      console.log(`  the contract agrees this key is the house`);
    }
  })
  .catch((e) => console.warn(`  could not read the contract: ${(e as Error).message.split("\n")[0]}`));

if (config.janitor) startJanitor();
else console.log("  janitor off: no transaction will ever be sent from this key");

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
