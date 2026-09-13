import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.ts";
import { chain, cluckr, houseAccount, onChainHouse, readParams } from "./chain.ts";
import { liveCount } from "./db.ts";
import { HouseError, issueCommitment, revealFor } from "./house.ts";
import { janitorLog } from "./janitor.ts";

/**
 * Three routes and a health check, plain node:http.
 *
 *   POST /commit   { player }      → a signed hash-chain commitment for `startRound`
 *   GET  /reveal/:id/:level         → the seed settling that lift, once the lift is on chain
 *   GET  /health                    → who the house is, what it points at, how many rounds are live
 *   GET  /janitor                   → the janitor's last 200 lines
 */

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": config.origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new HouseError("body too large", 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HouseError("body must be JSON");
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    let houseMatches: boolean | null = null;
    let params: Awaited<ReturnType<typeof readParams>> | null = null;
    try {
      const [h, p] = await Promise.all([onChainHouse(), readParams()]);
      houseMatches = h.toLowerCase() === houseAccount.address.toLowerCase();
      params = p;
    } catch {
      /* chain unreachable: reported below */
    }
    json(res, 200, {
      ok: houseMatches === true,
      house: houseAccount.address,
      houseMatches,
      cluckr: cluckr(),
      chainId: chain.id,
      rpc: config.rpcUrl,
      liveRounds: liveCount(),
      janitor: config.janitor,
      revealAfterSeconds: config.revealAfterSeconds,
      commitMinutes: config.commitMinutes,
      params,
    });
    return;
  }

  if (req.method === "GET" && path === "/janitor") {
    json(res, 200, { lines: janitorLog });
    return;
  }

  if (req.method === "POST" && path === "/commit") {
    const body = (await readBody(req)) as { player?: unknown };
    if (typeof body.player !== "string") throw new HouseError("player is required");
    json(res, 200, await issueCommitment(body.player, houseAccount.address));
    return;
  }

  const reveal = /^\/reveal\/(\d+)\/(\d+)$/.exec(path);
  if (req.method === "GET" && reveal) {
    json(res, 200, await revealFor(Number(reveal[1]), Number(reveal[2])));
    return;
  }

  json(res, 404, { error: "not found" });
}

export function startHttp(port = config.port) {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HouseError) {
        json(res, e.status, { error: e.message });
      } else {
        console.error(e);
        json(res, 500, { error: "the house stumbled; try again" });
      }
    });
  });
  server.listen(port);
  return server;
}
