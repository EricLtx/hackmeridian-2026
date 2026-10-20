// RPC endpoints: a call that does not answer in time, or fails on the
// network, moves to the next endpoint and stays there; a request the RPC
// refuses does not. No network: the endpoints are stand-ins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chain, RpcTimeout, withTimeout } from "../src/chain.js";

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
