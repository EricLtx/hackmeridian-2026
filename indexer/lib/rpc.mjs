// RPC access with failover. `STELLAR_RPC_URLS` (comma-separated, tried in
// order on a network error or a 5xx), else `STELLAR_RPC_URL`, else the public
// testnet endpoint. A contract or request error (a start ledger outside the
// retention window, say) is not retried: the caller decides.

import { rpc } from "@stellar/stellar-sdk";

export const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const PAGE = 200;
const MAX_PAGES = 1000;

export function rpcUrls(env = process.env) {
  const list = (env.STELLAR_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return list;
  return [env.STELLAR_RPC_URL?.trim() || DEFAULT_RPC];
}

export function isTransient(error) {
  const text = `${error?.message ?? ""} ${error?.cause?.code ?? ""} ${error?.response?.status ?? ""} ${error?.code ?? ""}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout|\b(429|50[0-4])\b/i.test(text);
}

/** The ledger an event cursor (`<toid>-<index>`) points at: the top 32 bits of the toid. */
export function cursorLedger(cursor) {
  const toid = /^(\d+)-/.exec(String(cursor ?? ""))?.[1];
  return toid ? Number(BigInt(toid) >> 32n) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Rpc {
  constructor(urls = rpcUrls(), { log = () => {} } = {}) {
    this.urls = urls;
    this.servers = urls.map((u) => new rpc.Server(u, { allowHttp: u.startsWith("http://") }));
    this.current = 0;
    this.log = log;
  }

  get url() {
    return this.urls[this.current];
  }

  /** Runs `call(server)`; on a transient failure, moves to the next URL, up to three rounds over the list. */
  async call(label, fn) {
    const attempts = this.urls.length * 3;
    let delay = 1000;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn(this.servers[this.current]);
      } catch (error) {
        if (!isTransient(error) || attempt >= attempts) throw error;
        const failed = this.url;
        this.current = (this.current + 1) % this.urls.length;
        this.log(`network: ${label} failed on ${failed} (${(error.message ?? "").split("\n")[0].slice(0, 120)}); next ${this.url} in ${delay / 1000} s`);
        await sleep(delay);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  health() {
    return this.call("health", (s) => s.getHealth());
  }

  latestLedger() {
    return this.call("latest ledger", (s) => s.getLatestLedger());
  }

  /**
   * Every contract event after `from` (`{ startLedger }` or `{ cursor }`),
   * through all pages. Returns `{ events, latestLedger, oldestLedger, startLedger }`
   * where `startLedger` is the ledger the fetch actually began at: when the
   * requested start is older than the window, the RPC's oldest ledger is
   * used and the caller records the gap.
   */
  async events(contractId, from) {
    const out = [];
    let request = { filters: [{ type: "contract", contractIds: [contractId] }], limit: PAGE, ...from };
    let latestLedger = null;
    let oldestLedger = null;
    let startLedger = from.startLedger ?? null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let response;
      try {
        response = await this.call("events", (s) => s.getEvents(request));
      } catch (error) {
        const range = /within the ledger range: (\d+) - (\d+)/.exec(error.message ?? "");
        if (page === 0 && range) {
          // Requested start older than the window: begin at the oldest kept ledger.
          startLedger = Number(range[1]);
          request = { filters: request.filters, limit: PAGE, startLedger };
          page -= 1;
          continue;
        }
        throw error;
      }
      latestLedger = response.latestLedger ?? latestLedger;
      oldestLedger = response.oldestLedger ?? oldestLedger;
      out.push(...response.events);
      // The RPC scans at most about 10,000 ledgers per request and returns a
      // cursor at the end of the scanned stretch even when it holds no event:
      // keep going until the cursor reaches the latest ledger.
      const next = response.cursor;
      if (!next || next === request.cursor) break;
      const reached = cursorLedger(next);
      if (response.events.length < PAGE && (reached === null || latestLedger === null || reached >= latestLedger)) break;
      request = { filters: request.filters, limit: PAGE, cursor: next };
    }
    return { events: out, latestLedger, oldestLedger, startLedger };
  }
}
