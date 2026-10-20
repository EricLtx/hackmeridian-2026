// RPC endpoints: a call that does not answer in time, or fails on the
// network, moves to the next endpoint and stays there; a request the RPC
// refuses does not. No network: the endpoints are stand-ins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chain, RETURN_QUIET_MS, RpcTimeout, pickEndpoint, rpcChangeText, rpcServer, withTimeout } from "../src/chain.js";

const dep = JSON.parse(readFileSync(new URL("../public/deployment.testnet.json", import.meta.url), "utf8"));
const never = () => new Promise(() => {});
const healthy = async () => ({ status: "healthy" });
const fake = (host, server) => ({ url: `https://${host}`, host, server, lastMs: null, failures: 0 });

function chainWith(...endpoints) {
  const chain = new Chain(dep);
  chain.endpoints = endpoints;
  chain.active = 0;
  return chain;
}

test("the deployment's fallbacks become endpoints, the first one in use", () => {
  const chain = new Chain(dep);
  assert.equal(chain.endpoints.length, 1 + (dep.rpcFallbacks?.length ?? 0));
  assert.ok(chain.endpoints.length >= 2, "the published deployment carries a fallback RPC");
  assert.equal(chain.rpcInfo().host, new URL(dep.rpcUrl).host);
  assert.equal(chain.server, chain.endpoints[0].server);
  assert.equal(new Chain({ ...dep, rpcFallbacks: [dep.rpcUrl] }).endpoints.length, 1, "a fallback equal to the first endpoint is dropped");
});

test("a call that does not answer in time moves to the next endpoint and stays there", async () => {
  const chain = chainWith(fake("slow.example", { getHealth: never }), fake("fast.example", { getHealth: healthy }));
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change);
  assert.equal((await chain.net(() => chain.server.getHealth(), { timeoutMs: 30 })).status, "healthy");
  assert.equal(chain.rpcInfo().host, "fast.example");
  assert.notEqual(chain.rpcInfo().ms, null);
  assert.deepEqual(changes, [{ from: "slow.example", to: "fast.example", reason: "timeout" }]);
  await chain.net(() => chain.server.getHealth(), { timeoutMs: 30 });
  assert.equal(changes.length, 1, "the next call starts on the endpoint that answered");
});

test("a network failure moves too; a request the RPC refuses does not", async () => {
  const down = chainWith(
    fake("down.example", {
      getHealth: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
    fake("up.example", { getHealth: healthy }),
  );
  assert.equal((await down.net(() => down.server.getHealth(), { timeoutMs: 50 })).status, "healthy");
  assert.equal(down.rpcInfo().host, "up.example");

  const refused = Object.assign(new Error("Request failed with status code 400"), { response: { status: 400 } });
  const bad = chainWith(
    fake("a.example", {
      getHealth: async () => {
        throw refused;
      },
    }),
    fake("b.example", { getHealth: healthy }),
  );
  await assert.rejects(bad.net(() => bad.server.getHealth(), { timeoutMs: 50 }), /400/);
  assert.equal(bad.rpcInfo().host, "a.example");
});

test("with every endpoint silent, the call gives up after its attempts with a timeout", async () => {
  const chain = chainWith(fake("a.example", { getHealth: never }), fake("b.example", { getHealth: never }));
  await assert.rejects(chain.net(() => chain.server.getHealth(), { timeoutMs: 20, attempts: 3 }), RpcTimeout);
});

test("a failing listener never stops a call", async () => {
  const chain = chainWith(fake("slow.example", { getHealth: never }), fake("fast.example", { getHealth: healthy }));
  chain.onRpcChange = () => {
    throw new Error("listener broke");
  };
  assert.equal((await chain.net(() => chain.server.getHealth(), { timeoutMs: 30 })).status, "healthy");
});

test("withTimeout passes a value through and turns a late one into an RpcTimeout", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(withTimeout(never(), 10), RpcTimeout);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 50), /boom/);
});

test("many calls failing at once switch once, not back and forth", async () => {
  const down = async () => {
    throw new TypeError("Failed to fetch");
  };
  const chain = chainWith(fake("down.example", { getHealth: down }), fake("up.example", { getHealth: healthy }));
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change);
  const results = await Promise.all(Array.from({ length: 12 }, () => chain.net(() => chain.server.getHealth(), { timeoutMs: 50 })));
  assert.ok(results.every((r) => r.status === "healthy"));
  assert.equal(chain.rpcInfo().host, "up.example");
  assert.equal(changes.length, 1);
});

test("every endpoint down: many calls switch once, then give up instead of bouncing", async () => {
  const down = async () => {
    throw new TypeError("Failed to fetch");
  };
  const chain = chainWith(fake("a.example", { getHealth: down }), fake("b.example", { getHealth: down }));
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change);
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => chain.net(() => chain.server.getHealth(), { timeoutMs: 50, attempts: 2 })));
  assert.ok(outcomes.every((o) => o.status === "rejected"));
  assert.equal(changes.length, 1);
});

test("Safari's network failure, 'Load failed', moves to the next endpoint too", async () => {
  // The case seen on an iPhone on 20 October: the page had moved to a fallback that refused
  // every call, and Safari's message was not taken for a network failure, so it never came back.
  const refusing = async () => {
    throw new TypeError("Load failed");
  };
  const chain = chainWith(fake("fallback.example", { getHealth: refusing }), fake("primary.example", { getHealth: healthy }));
  assert.equal((await chain.net(() => chain.server.getHealth(), { timeoutMs: 50 })).status, "healthy");
  assert.equal(chain.rpcInfo().host, "primary.example");
});

test("RPC clients send only Content-Type, so a strict CORS preflight passes", async () => {
  const chain = new Chain(dep);
  for (const endpoint of chain.endpoints) {
    const headers = Object.keys(endpoint.server.httpClient.defaults.headers).map((h) => h.toLowerCase());
    assert.ok(!headers.includes("x-client-name") && !headers.includes("x-client-version"), endpoint.host);
  }
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push([...new Headers(init?.headers ?? {}).keys()].sort());
    const result = { status: "healthy", latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 1 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await rpcServer("https://rpc.example").getHealth();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [["content-type"]]);
});

test("staleness: calls leave an endpoint more than 10 ledgers behind, and return to the first once it is level", () => {
  const move = (heights, active) => {
    const { index, reason, behind } = pickEndpoint(heights, active);
    return [index, reason, behind];
  };
  assert.deepEqual(move([100, 100], 0), [0, null, 0], "level: stay");
  assert.deepEqual(move([90, 100], 0), [0, null, 0], "10 behind is still tolerated");
  assert.deepEqual(move([89, 100], 0), [1, "behind", 11]);
  assert.deepEqual(move([100, 100], 1), [0, "level", 0], "back to the first once level");
  assert.deepEqual(move([99, 100], 1), [0, "level", 0], "one ledger apart counts as level");
  assert.deepEqual(move([98, 100], 1), [1, null, 0], "the first is still catching up: stay on the fallback");
  assert.deepEqual(move([100, 80], 1), [0, "level", 0]);
  assert.deepEqual(move([null, 100], 1), [1, null, 0], "an endpoint that did not answer is not a target");
  assert.deepEqual(move([100, null], 0), [0, null, 0], "nor a reason to move");
  assert.deepEqual(move([null, null], 0), [0, null, 0]);
  assert.deepEqual(move([80, 95, 100], 0), [2, "behind", 20], "to the first endpoint that is level, not merely closer");
  assert.deepEqual(move([80, 100, 100], 0), [1, "behind", 20]);
});

test("the height poll moves a lagging endpoint's calls, reads an unhealthy one's height, and ignores a silent one", async () => {
  const health = (latestLedger) => async () => ({ status: "healthy", latestLedger });
  const changes = [];
  const lagging = chainWith(fake("lagging.example", { getHealth: health(5_293_700) }), fake("current.example", { getHealth: health(5_293_787) }));
  lagging.onRpcChange = (change) => changes.push(change);
  assert.deepEqual(await lagging.checkHeights(), [5_293_700, 5_293_787]);
  assert.equal(lagging.rpcInfo().host, "current.example");
  assert.deepEqual(changes, [{ from: "lagging.example", to: "current.example", reason: "behind", behind: 87 }]);

  // getHealth refuses on an endpoint whose last ledger is old: its height comes from getLatestLedger.
  const unhealthy = async () => {
    throw { code: -32603, message: "latency (95s) since last known ledger closed is too high (>30s)" };
  };
  const stale = chainWith(fake("stale.example", { getHealth: unhealthy, getLatestLedger: async () => ({ sequence: 5_293_770 }) }), fake("current.example", { getHealth: health(5_293_787) }));
  assert.deepEqual(await stale.checkHeights(), [5_293_770, 5_293_787]);
  assert.equal(stale.rpcInfo().host, "current.example");

  // Back to the first endpoint once it is level again.
  const back = chainWith(fake("first.example", { getHealth: health(5_293_787) }), fake("second.example", { getHealth: health(5_293_787) }));
  back.active = 1;
  const returned = [];
  back.onRpcChange = (change) => returned.push(change.reason);
  await back.checkHeights();
  assert.equal(back.rpcInfo().host, "first.example");
  assert.deepEqual(returned, ["level"]);

  // An endpoint left after a failed call rests before calls return to it, level or not.
  const rested = chainWith(fake("first.example", { getHealth: health(5_293_787) }), fake("second.example", { getHealth: health(5_293_787) }));
  rested.active = 1;
  rested.endpoints[0].failedAt = Date.now();
  await rested.checkHeights();
  assert.equal(rested.rpcInfo().host, "second.example", "a minute of rest first");
  rested.endpoints[0].failedAt = Date.now() - RETURN_QUIET_MS - 1;
  await rested.checkHeights();
  assert.equal(rested.rpcInfo().host, "first.example");
  // failover marks the endpoint it leaves.
  const marked = chainWith(fake("slow.example", { getHealth: never }), fake("fast.example", { getHealth: health(1) }));
  await marked.net(() => marked.server.getHealth(), { timeoutMs: 20 });
  assert.ok(Date.now() - marked.endpoints[0].failedAt < 5_000);

  // A silent endpoint has no height: nothing moves on its account.
  const down = async () => {
    throw new TypeError("Failed to fetch");
  };
  const silent = chainWith(fake("first.example", { getHealth: health(5_293_787) }), fake("silent.example", { getHealth: down, getLatestLedger: down }));
  assert.deepEqual(await silent.checkHeights(), [5_293_787, null]);
  assert.equal(silent.rpcInfo().host, "first.example");
  assert.deepEqual(await chainWith(fake("only.example", { getHealth: health(1) })).checkHeights(), [], "one endpoint: nothing to compare");
});

test("every move between endpoints is told in a sentence", () => {
  assert.equal(rpcChangeText({ from: "a.example", to: "b.example", reason: "timeout" }), "RPC a.example did not answer in time: switched to b.example.");
  assert.equal(rpcChangeText({ from: "a.example", to: "b.example", reason: "error" }), "RPC a.example failed: switched to b.example.");
  assert.equal(rpcChangeText({ from: "a.example", to: "b.example", reason: "behind", behind: 87 }), "RPC a.example is 87 ledgers behind: switched to b.example.");
  assert.equal(rpcChangeText({ from: "b.example", to: "a.example", reason: "level" }), "RPC a.example has caught up: switched back to it.");
});
