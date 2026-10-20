// RPC endpoints: a call that does not answer in time, or fails on the
// network, moves to the next endpoint and stays there; a request the RPC
// refuses does not. No network: the endpoints are stand-ins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  Chain,
  HEIGHT_BUDGET_MS,
  MAX_IN_FLIGHT,
  MAX_REST_MS,
  RETURN_QUIET_MS,
  RpcTimeout,
  pickEndpoint,
  restAfterFailure,
  rpcChangeText,
  rpcServer,
  withTimeout,
} from "../src/chain.js";

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

/** A height as an endpoint reports it, its latest ledger closed `age` seconds before `NOW` (null: no close time given). */
const NOW = 1_792_500_000;
const r = (height, age) => ({ height, closeTime: age === null ? null : NOW - age });
const move = (reads, active) => {
  const { index, reason, behind } = pickEndpoint(reads, active, NOW);
  return [index, reason, behind];
};

test("staleness: calls leave an endpoint more than 10 ledgers behind and a minute old by its own clock, and return to the first once it is level or current", () => {
  assert.deepEqual(move([r(100, 2), r(100, 2)], 0), [0, null, 0], "level: stay");
  assert.deepEqual(move([r(90, 70), r(100, 2)], 0), [0, null, 0], "10 behind is still tolerated");
  assert.deepEqual(move([r(89, 70), r(100, 2)], 0), [1, "behind", 11]);
  assert.deepEqual(move([r(100, 2), r(100, 2)], 1), [0, "level", 0], "back to the first once level");
  assert.deepEqual(move([r(99, 30), r(100, 2)], 1), [0, "level", 0], "one ledger apart counts as level");
  assert.deepEqual(move([r(98, 30), r(100, 2)], 1), [1, null, 0], "the first is still catching up: stay on the fallback");
  assert.deepEqual(move([r(100, 2), r(80, 100)], 1), [0, "level", 0]);
  assert.deepEqual(move([null, r(100, 2)], 1), [1, null, 0], "an endpoint that did not answer is not a target");
  assert.deepEqual(move([r(100, 2), null], 0), [0, null, 0], "nor a reason to move");
  assert.deepEqual(move([null, null], 0), [0, null, 0]);
  assert.deepEqual(move([r(80, 90), r(95, 2), r(100, 2)], 0), [2, "behind", 20], "to the first endpoint that is level, not merely closer");
  assert.deepEqual(move([r(80, 90), r(100, 2), r(100, 2)], 0), [1, "behind", 20]);
});

test("freshness: another endpoint's height alone neither takes the calls from a current first endpoint nor keeps them from it", () => {
  const N = 5_296_165;
  // The first endpoint closed a ledger 3 s ago; the fallback claims 11 more, or any height, stamped now.
  for (const claim of [N + 11, N + 1_000, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(move([r(N, 3), r(claim, 0)], 0), [0, null, 0], `a claim of ${claim} moves nothing`);
  }
  assert.deepEqual(move([r(N - 11, 50), r(N, 1)], 0), [0, null, 0], "under a minute old by its own clock: not stale yet");
  assert.deepEqual(move([r(N - 12, 70), r(N, 2)], 0), [1, "behind", 12], "a first endpoint really behind still loses the calls");
  assert.deepEqual(move([r(N - 12, null), r(N, 2)], 0), [0, null, 0], "no close time of its own: another endpoint's height is no proof");
  // On the fallback: the first endpoint returns when its own close time is current, whatever the fallback claims.
  assert.deepEqual(move([r(N, 3), r(N + 50, 0)], 1), [0, "level", 0]);
  assert.deepEqual(move([r(N - 5, 10), r(N, 0)], 1), [0, "level", 0], "current by its own clock, though not level");
  assert.deepEqual(move([r(N - 5, 20), r(N, 0)], 1), [1, null, 0], "neither level nor current: stay");
});

test("the height poll moves a lagging endpoint's calls, reads an unhealthy one's height, and ignores a silent one", async () => {
  const now = () => Math.floor(Date.now() / 1000);
  const health = (latestLedger, age = 1) => async () => ({ status: "healthy", latestLedger, latestLedgerCloseTime: String(now() - age) });
  const changes = [];
  const lagging = chainWith(fake("lagging.example", { getHealth: health(5_293_700, 450) }), fake("current.example", { getHealth: health(5_293_787) }));
  lagging.onRpcChange = (change) => changes.push(change);
  assert.deepEqual(
    (await lagging.checkHeights()).map((read) => read.height),
    [5_293_700, 5_293_787],
  );
  assert.equal(lagging.rpcInfo().host, "current.example");
  assert.deepEqual(changes, [{ from: "lagging.example", to: "current.example", reason: "behind", behind: 87 }]);

  // getHealth refuses on an endpoint whose last ledger is old: its height and close time come from getLatestLedger.
  const unhealthy = async () => {
    throw { code: -32603, message: "latency (95s) since last known ledger closed is too high (>30s)" };
  };
  const stale = chainWith(
    fake("stale.example", { getHealth: unhealthy, getLatestLedger: async () => ({ sequence: 5_293_770, closeTime: String(now() - 95) }) }),
    fake("current.example", { getHealth: health(5_293_787) }),
  );
  const reads = await stale.checkHeights();
  assert.equal(reads[0].height, 5_293_770);
  assert.ok(Math.abs(reads[0].closeTime - (now() - 95)) <= 1, "the close time is read too");
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
  const silentReads = await silent.checkHeights();
  assert.equal(silentReads[0].height, 5_293_787);
  assert.equal(silentReads[1], null);
  assert.equal(silent.rpcInfo().host, "first.example");
  assert.deepEqual(await chainWith(fake("only.example", { getHealth: health(1) })).checkHeights(), [], "one endpoint: nothing to compare");
});

test("the height poll: a fallback that over-reports its height takes no call from a current first endpoint, and gives them back", async () => {
  // WEB-2: Gateway.fm, say, answers getHealth with 11 ledgers more than the chain has, stamped with the current time.
  const now = () => Math.floor(Date.now() / 1000);
  const N = 5_295_195;
  const health = (latestLedger, age) => async () => ({ status: "healthy", latestLedger, latestLedgerCloseTime: String(now() - age) });
  for (const claim of [N + 11, Number.MAX_SAFE_INTEGER]) {
    const changes = [];
    const chain = chainWith(fake("first.example", { getHealth: health(N, 2) }), fake("fallback.example", { getHealth: health(claim, 0) }));
    chain.onRpcChange = (change) => changes.push(change);
    for (let pass = 0; pass < 3; pass += 1) await chain.checkHeights();
    assert.equal(chain.rpcInfo().host, "first.example", `a claim of ${claim}`);
    assert.deepEqual(changes, []);
    assert.equal(chain.endpoints[0].failedAt, undefined);
  }
  // Already on the fallback (after a failed call and its rest): back to a current first endpoint, whatever the fallback claims.
  const back = chainWith(fake("first.example", { getHealth: health(N, 3) }), fake("fallback.example", { getHealth: health(N + 50, 0) }));
  back.active = 1;
  await back.checkHeights();
  assert.equal(back.rpcInfo().host, "first.example");
});

test("the height poll never holds a refresh pass more than about 1.5 s", async () => {
  // WEB-3: it ran before every pass, the first included, and waited 4 s for a silent endpoint, 8 s with its fallback.
  assert.equal(HEIGHT_BUDGET_MS, 1500);
  const now = () => Math.floor(Date.now() / 1000);
  const health = async () => ({ status: "healthy", latestLedger: 100, latestLedgerCloseTime: String(now()) });
  const timed = async (run) => {
    const started = Date.now();
    const value = await run();
    return { value, ms: Date.now() - started };
  };

  // One endpoint never answers getHealth: the poll and the pass's bounded wait both end at the budget.
  const silent = chainWith(fake("first.example", { getHealth: health }), fake("silent.example", { getHealth: never, getLatestLedger: never }));
  const poll = await timed(() => silent.checkHeights());
  assert.ok(poll.ms < 1700, `checkHeights took ${poll.ms} ms`);
  assert.equal(poll.value[0].height, 100);
  assert.equal(poll.value[1], null);
  const bounded = await timed(() => silent.pollHeights());
  assert.ok(bounded.ms < 1700, `pollHeights took ${bounded.ms} ms`);

  // An unhealthy endpoint that refuses getHealth after 1.2 s, then hangs on getLatestLedger: one budget for both.
  const refuses = () => new Promise((_, reject) => setTimeout(() => reject({ code: -32603, message: "latency (95s) since last known ledger closed is too high (>30s)" }), 1200));
  const slow = chainWith(fake("first.example", { getHealth: health }), fake("unhealthy.example", { getHealth: refuses, getLatestLedger: never }));
  const shared = await timed(() => slow.checkHeights());
  assert.ok(shared.ms < 1700, `getHealth and getLatestLedger shared ${shared.ms} ms`);

  // Whatever holds the poll, the pass waits at most the budget; a move decided later applies to later calls.
  const stuck = chainWith(fake("first.example", { getHealth: health }), fake("second.example", { getHealth: health }));
  stuck.checkHeights = never;
  const race = await timed(() => stuck.pollHeights(100));
  assert.equal(race.value, null);
  assert.ok(race.ms < 400, `pollHeights(100) took ${race.ms} ms`);
});

test("an endpoint that fails soon after each return rests longer each time, up to 10 minutes, and a minute again after a quiet period", async () => {
  // WEB-4. The rule.
  assert.equal(restAfterFailure({}, 1_000_000), RETURN_QUIET_MS, "a first failure: a minute");
  const failedAt = 1_000_000;
  const returnedAt = failedAt + 60_000;
  assert.equal(restAfterFailure({ restMs: 60_000, failedAt, returnedAt }, returnedAt + 20_000), 120_000, "failed 20 s after calls returned to it");
  assert.equal(restAfterFailure({ restMs: 480_000, failedAt, returnedAt }, returnedAt + 1_000), MAX_REST_MS);
  assert.equal(restAfterFailure({ restMs: MAX_REST_MS, failedAt, returnedAt }, returnedAt + 1_000), MAX_REST_MS, "capped");
  assert.equal(restAfterFailure({ restMs: 240_000, failedAt, returnedAt }, returnedAt + 300_000), RETURN_QUIET_MS, "quiet for longer than its rest: a minute again");
  assert.equal(MAX_REST_MS, 600_000);

  // The cycle the review saw on 20 October: each return to the first endpoint met a slow call at once.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const health = async () => ({ status: "healthy", latestLedger: 100, latestLedgerCloseTime: String(Math.floor(clock / 1000) - 2) });
    const chain = chainWith(fake("first.example", { getHealth: health }), fake("second.example", { getHealth: health }));
    const changes = [];
    chain.onRpcChange = (change) => changes.push(change.reason);
    const restOf = async () => {
      // One pass every 15 s until calls return to the first endpoint.
      const left = clock;
      while (chain.active === 1 && clock - left <= 20 * 60_000) {
        clock += 15_000;
        await chain.checkHeights();
      }
      return (clock - left) / 1000;
    };
    const rests = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      assert.ok(chain.failover(new RpcTimeout(7000), 0), "a slow call on the first endpoint, just after calls returned to it");
      rests.push(await restOf());
    }
    assert.deepEqual(rests, [60, 120, 240, 480, 600]);
    assert.equal(changes.length, 10, "two notices per cycle, five cycles in 25 minutes rather than one a minute");
    // The first endpoint then serves calls quietly for longer than its rest: its next failure rests a minute.
    clock += MAX_REST_MS + 1;
    chain.failover(new RpcTimeout(7000), 0);
    assert.equal(await restOf(), 60);
  } finally {
    Date.now = realNow;
  }
});

test("a failing call skips an endpoint that is resting, unless every other one is too", () => {
  const chain = chainWith(fake("a.example", {}), fake("b.example", {}), fake("c.example", {}));
  chain.endpoints[1].failedAt = Date.now(); // b failed a moment ago
  assert.ok(chain.failover(new RpcTimeout(7000), 0));
  assert.equal(chain.rpcInfo().host, "c.example", "b rests: c takes the calls");
  // a just failed and b rests: when c fails too, every other endpoint rests, and calls go to the next one.
  assert.ok(chain.failover(new RpcTimeout(7000), 2));
  assert.equal(chain.rpcInfo().host, "a.example");
  // With two endpoints the other one takes the calls, resting or not.
  const two = chainWith(fake("a.example", {}), fake("b.example", {}));
  two.endpoints[1].failedAt = Date.now();
  assert.ok(two.failover(new RpcTimeout(7000), 0));
  assert.equal(two.rpcInfo().host, "b.example");
});

test("an HTTP 429 is back-pressure on the same endpoint, not a failover", async () => {
  const tooMany = (retryAfter) =>
    Object.assign(new Error("Request failed with status code 429"), { response: { status: 429, headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }) } });
  let calls = 0;
  const busy = fake("busy.example", {
    getHealth: async () => {
      calls += 1;
      if (calls < 3) throw tooMany("0");
      return { status: "healthy" };
    },
  });
  const chain = chainWith(busy, fake("other.example", { getHealth: healthy }));
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change);
  assert.equal((await chain.net(() => chain.server.getHealth())).status, "healthy");
  assert.equal(calls, 3, "sent there again, as the endpoint asked");
  assert.equal(chain.rpcInfo().host, "busy.example");
  assert.deepEqual(changes, []);

  // A browser sees no Retry-After unless the endpoint exposes it: about a second.
  let once = 0;
  const plain = chainWith(
    fake("busy.example", {
      getHealth: async () => {
        once += 1;
        if (once === 1) throw tooMany();
        return { status: "healthy" };
      },
    }),
    fake("other.example", { getHealth: healthy }),
  );
  const started = Date.now();
  await plain.net(() => plain.server.getHealth());
  const waited = Date.now() - started;
  assert.ok(waited >= 900 && waited < 2500, `waited ${waited} ms`);
  assert.equal(plain.rpcInfo().host, "busy.example");

  // The review's case: a 429 from the fallback while the first endpoint rests never sends calls back to it.
  const back = chainWith(fake("first.example", {}), fake("fallback.example", {}));
  assert.ok(back.failover(new RpcTimeout(7000), 0));
  assert.equal(back.failover(tooMany(), 1), false);
  assert.equal(back.rpcInfo().host, "fallback.example");
});

const tooManyWith = (retryAfter) =>
  Object.assign(new Error("Request failed with status code 429"), { response: { status: 429, headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }) } });
const refusingAsTooMany = (retryAfter) => async () => {
  throw tooManyWith(retryAfter);
};
const healthAt = (height) => async () => ({ status: "healthy", latestLedger: height, latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)) });

test("an endpoint that answers HTTP 429 to everything is left after three in a row within one call: the reads land on the other endpoint", async () => {
  let busyCalls = 0;
  let healthyCalls = 0;
  const chain = chainWith(
    fake("busy.example", {
      getHealth: refusingAsTooMany("0"),
      simulateTransaction: async () => {
        busyCalls += 1;
        throw tooManyWith("0");
      },
    }),
    fake("healthy.example", {
      getHealth: healthAt(100),
      simulateTransaction: async () => {
        healthyCalls += 1;
        return { ok: true };
      },
    }),
  );
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change);
  let ok = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    await chain.pollHeights();
    const results = await Promise.all(Array.from({ length: 20 }, () => chain.net(() => chain.server.simulateTransaction()).then(() => true, () => false)));
    ok += results.filter(Boolean).length;
  }
  assert.equal(ok, 40, "every read of both passes lands");
  assert.equal(healthyCalls, 40);
  assert.equal(chain.rpcInfo().host, "healthy.example");
  assert.deepEqual(changes, [{ from: "busy.example", to: "healthy.example", reason: "rate-limited" }], "one move, at the third 429 of one call");
  assert.ok(busyCalls <= 20 * 3, `${busyCalls} calls sent to the busy endpoint`);
  assert.match(rpcChangeText(changes[0]), /busy\.example keeps refusing requests as too many: switched to healthy\.example/);
  // Two 429s then an answer is a burst, waited out on the same endpoint, as before.
  let burst = 0;
  const bursty = chainWith(
    fake("bursty.example", {
      getHealth: async () => {
        burst += 1;
        if (burst < 3) throw tooManyWith("0");
        return { status: "healthy" };
      },
    }),
    fake("other.example", { getHealth: healthy }),
  );
  assert.equal((await bursty.net(() => bursty.server.getHealth())).status, "healthy");
  assert.equal(bursty.rpcInfo().host, "bursty.example");
});

test("calls that come back to an endpoint start its count of 429 polls again: one 429 poll after the return moves nothing, three do", async () => {
  let polls = 0;
  let aHealth = async () => {
    polls += 1;
    throw tooManyWith("0");
  };
  const a = fake("a.example", { getHealth: () => aHealth(), simulateTransaction: never });
  const b = fake("b.example", { getHealth: healthAt(100), simulateTransaction: never });
  const chain = chainWith(a, b);
  const changes = [];
  chain.onRpcChange = (change) => changes.push(`${change.reason}:${change.to}`);
  // Two 429 polls on a, then a call that times out twice (the first timeout is retried there): calls move to b.
  await chain.checkHeights();
  await chain.checkHeights();
  assert.equal(polls, 2);
  assert.equal(chain.rpcInfo().host, "a.example");
  await assert.rejects(chain.net(() => chain.server.simulateTransaction(), { timeoutMs: 20, attempts: 3 }), RpcTimeout);
  assert.equal(chain.rpcInfo().host, "b.example");
  // b fails too while a rests: the calls come back to a by net()'s own return.
  await assert.rejects(chain.net(() => chain.server.simulateTransaction(), { timeoutMs: 20, attempts: 3 }), RpcTimeout);
  assert.equal(chain.rpcInfo().host, "a.example");
  assert.deepEqual(changes, ["timeout:b.example", "timeout:a.example"]);
  // b's rest is over by now; a answers its poll with a 429 once: no move.
  b.failedAt = Date.now() - 2 * RETURN_QUIET_MS;
  await chain.checkHeights();
  assert.equal(chain.rpcInfo().host, "a.example", "one 429 poll after the return");
  assert.equal(changes.length, 2);
  await chain.checkHeights();
  assert.equal(chain.rpcInfo().host, "a.example", "two");
  await chain.checkHeights();
  assert.equal(chain.rpcInfo().host, "b.example", "three in a row");
  assert.equal(changes[2], "rate-limited:b.example");
  aHealth = healthAt(100);
});

test("a Retry-After longer than a timeout leaves the endpoint at the first 429; with every other endpoint resting, the call keeps waiting instead", async () => {
  let busyCalls = 0;
  const busy = (retryAfter) =>
    fake("busy.example", {
      getHealth: async () => {
        busyCalls += 1;
        throw tooManyWith(retryAfter);
      },
    });
  const chain = chainWith(busy("30"), fake("other.example", { getHealth: healthy }));
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change.reason);
  const started = Date.now();
  assert.equal((await chain.net(() => chain.server.getHealth())).status, "healthy");
  assert.ok(Date.now() - started < 1000, "no wait of 30 s, nor of the 5 s cap");
  assert.equal(busyCalls, 1);
  assert.deepEqual(changes, ["rate-limited"]);
  assert.equal(chain.rpcInfo().host, "other.example");

  // The other endpoint rests after a failure of its own: the third 429 in a row is then waited out too, and the call ends with the 429 after its attempts.
  busyCalls = 0;
  const alone = chainWith(busy("0"), fake("other.example", { getHealth: healthy }));
  alone.endpoints[1].failedAt = Date.now();
  const moves = [];
  alone.onRpcChange = (change) => moves.push(change.reason);
  await assert.rejects(alone.net(() => alone.server.getHealth()), /status code 429/);
  assert.equal(busyCalls, 4, "sent there again after every wait");
  assert.deepEqual(moves, []);
  assert.equal(alone.rpcInfo().host, "busy.example");
});

test("three height polls in a row answered 429 by the endpoint in use move the calls; an answered poll resets the count", async () => {
  let polls = 0;
  const chain = chainWith(
    fake("busy.example", {
      getHealth: async () => {
        polls += 1;
        if (polls === 2) return { status: "healthy", latestLedger: 100, latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)) };
        throw tooManyWith("0");
      },
    }),
    fake("other.example", { getHealth: healthAt(100) }),
  );
  const changes = [];
  chain.onRpcChange = (change) => changes.push(change.reason);
  for (let pass = 1; pass <= 4; pass += 1) {
    await chain.checkHeights();
    assert.equal(chain.rpcInfo().host, "busy.example", `pass ${pass}: 429, answer, 429, 429`);
  }
  assert.deepEqual(changes, []);
  await chain.checkHeights();
  assert.equal(chain.rpcInfo().host, "other.example", "the third 429 in a row");
  assert.deepEqual(changes, ["rate-limited"]);
  // The busy endpoint rests: the next poll brings nothing back to it.
  await chain.checkHeights();
  assert.equal(chain.rpcInfo().host, "other.example");
});

test("at most 6 calls are in flight on one endpoint; calls waiting for a slot follow a move", async () => {
  assert.equal(MAX_IN_FLIGHT, 6);
  let inFlight = 0;
  let peak = 0;
  const counting = fake("a.example", {
    getHealth: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { status: "healthy" };
    },
  });
  const chain = chainWith(counting, fake("b.example", { getHealth: healthy }));
  const results = await Promise.all(Array.from({ length: 20 }, () => chain.net(() => chain.server.getHealth())));
  assert.ok(results.every((r) => r.status === "healthy"));
  assert.equal(peak, MAX_IN_FLIGHT, "one board pass sent 31 requests in a second; Gateway.fm allows 30 per second per IP");
  assert.equal(chain.endpoints[0].inFlight, 0, "every slot is given back");

  // An endpoint that hangs: the first six time out and move the calls; those waiting for a slot go to the new endpoint.
  const hung = chainWith(fake("hung.example", { getHealth: never }), fake("up.example", { getHealth: healthy }));
  const changes = [];
  hung.onRpcChange = (change) => changes.push(change);
  const started = Date.now();
  const all = await Promise.all(Array.from({ length: 12 }, () => hung.net(() => hung.server.getHealth(), { timeoutMs: 50 })));
  assert.ok(all.every((r) => r.status === "healthy"));
  assert.equal(changes.length, 1);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("at most 20 calls reach one endpoint in any one second: 60 issued at once arrive in three waves and all complete", async () => {
  const PER_SECOND = 20; // RATE_PER_SECOND
  const arrivals = [];
  const counting = fake("gw.example", {
    getHealth: async () => {
      arrivals.push(Date.now());
      return { status: "healthy" };
    },
  });
  const chain = chainWith(counting, fake("b.example", { getHealth: healthy }));
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 60 }, () => chain.net(() => chain.server.getHealth())));
  const ms = Date.now() - started;
  assert.equal(results.length, 60);
  assert.ok(results.every((r) => r.status === "healthy"));
  assert.equal(arrivals.length, 60);
  for (const t of arrivals) {
    const within = arrivals.filter((u) => u >= t && u < t + 1000).length;
    assert.ok(within <= PER_SECOND, `${within} calls within one second from ${t - started} ms`);
  }
  assert.ok(ms >= 2000 && ms < 3500, `60 calls took ${ms} ms`);
  assert.equal(chain.rpcInfo().host, "gw.example", "a wait for a turn is not a failure");

  // The cost on an ordinary board pass, offline: its calls, and the time at 0 ms and at 120 ms per call.
  const stubServer = (latency) => {
    let calls = 0;
    const answer = async (value) => {
      calls += 1;
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
      return value;
    };
    return {
      calls: () => calls,
      simulateTransaction: () => answer({ latestLedger: 1, minResourceFee: "0", result: { auth: [], retval: xdr.ScVal.scvVoid() } }),
      getLatestLedger: () => answer({ sequence: 1, closeTime: String(Math.floor(Date.now() / 1000)) }),
    };
  };
  for (const latency of [0, 120]) {
    const server = stubServer(latency);
    const board = chainWith(fake("a.example", server), fake("b.example", server));
    const from = Date.now();
    await board.board(10_000_000n);
    console.log(`board pass under the rate window: ${server.calls()} calls in ${Date.now() - from} ms at ${latency} ms per call`);
  }
});

test("a call started before a round trip away and back, timing out after the return, moves nothing: one move in all", async () => {
  const chain = chainWith(fake("sdf.example", { getHealth: never, getLatestLedger: never }), fake("gfm.example", { getHealth: healthy, getLatestLedger: never }));
  const changes = [];
  chain.onRpcChange = (c) => changes.push(`${c.from}->${c.to}:${c.reason}`);
  // A long call (a scan of events, bound 300 ms here) and a short one are launched together on the first endpoint.
  const long = chain.net(() => chain.server.getLatestLedger(), { timeoutMs: 300, attempts: 2 }).then(
    () => "answered",
    (e) => e.name,
  );
  const short = await chain.net(() => chain.server.getHealth(), { timeoutMs: 40 });
  assert.equal(short.status, "healthy");
  assert.equal(chain.rpcInfo().host, "gfm.example");
  // The calls come back to the first endpoint (a level return of the height poll, or net()'s own return) before the long call ends.
  chain.moveTo(0);
  assert.equal(await long, "RpcTimeout");
  assert.deepEqual(changes, ["sdf.example->gfm.example:timeout"], "the long call's timeout is a failure of the past");
  assert.equal(chain.rpcInfo().host, "sdf.example");
  assert.equal(chain.moveCount, 2);
});

test("a read moves away on the second timeout within 30 s of the endpoint in use, not on the first; a send still moves at once", async () => {
  // One stall, then a normal answer: the read goes to the same endpoint once more and nothing moves.
  const stalling = (pattern) => {
    let n = 0;
    return () => (pattern[n++ % pattern.length] ? never() : healthy());
  };
  const once = chainWith(fake("a.example", { getHealth: stalling([true, false]) }), fake("b.example", { getHealth: healthy }));
  const changes = [];
  once.onRpcChange = (change) => changes.push(change.reason);
  assert.equal((await once.net(() => once.server.getHealth(), { timeoutMs: 30 })).status, "healthy");
  assert.equal(once.rpcInfo().host, "a.example");
  assert.deepEqual(changes, []);
  // A second stall within 30 s, on the next read: the reads move.
  assert.equal((await once.net(() => once.server.getHealth(), { timeoutMs: 30 })).status, "healthy");
  assert.equal(once.rpcInfo().host, "b.example");
  assert.deepEqual(changes, ["timeout"]);

  // Two stalls 40 s apart: each is a first one.
  const apart = chainWith(fake("a.example", { getHealth: stalling([true, false]) }), fake("b.example", { getHealth: healthy }));
  apart.endpoints[0].timedOutAt = Date.now() - 40_000;
  assert.equal((await apart.net(() => apart.server.getHealth(), { timeoutMs: 30 })).status, "healthy");
  assert.equal(apart.rpcInfo().host, "a.example");

  // A send that times out moves at once, as before (the send calls failover itself).
  const send = chainWith(fake("a.example", {}), fake("b.example", {}));
  assert.ok(send.failover(new RpcTimeout(10_000), 0, { since: send.moveCount }));
  assert.equal(send.rpcInfo().host, "b.example");
});

test("a scan of events whose bounds came from one endpoint and whose calls moved to another starts again on that one, instead of 'startLedger must be within the ledger range'", async () => {
  const G = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
  const raw = (ledger, name, ...topics) => ({
    ledger,
    ledgerClosedAt: "2026-10-20T20:00:00Z",
    txHash: "ab".repeat(32),
    id: `${ledger}-1`,
    topic: [xdr.ScVal.scvSymbol(name), ...topics],
    value: xdr.ScVal.scvVoid(),
  });
  const run = async (scan) => {
    const requests = [];
    // The first endpoint keeps ledgers 100 to 200 and fails every getEvents on the network; the second keeps 150 to 200.
    const a = fake("a.example", {
      getHealth: async () => ({ status: "healthy", oldestLedger: 100, latestLedger: 200 }),
      getEvents: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const b = fake("b.example", {
      getHealth: async () => ({ status: "healthy", oldestLedger: 150, latestLedger: 200 }),
      getEvents: async (request) => {
        requests.push(request.startLedger ?? "cursor");
        if (request.startLedger < 150) throw new Error("startLedger must be within the ledger range: 150 - 200");
        return { events: [raw(160, "repo_opened", nativeToScVal(5n, { type: "u64" }), nativeToScVal(G, { type: "address" }))], latestLedger: 200, cursor: null };
      },
    });
    const chain = chainWith(a, b);
    return { result: await scan(chain), requests, host: chain.rpcInfo().host };
  };
  const tape = await run((chain) => chain.contractEvents(100));
  assert.equal(tape.result.events.length, 1);
  assert.equal(tape.result.events[0].event, "repo_opened");
  assert.equal(tape.result.nextLedger, 200);
  assert.deepEqual(tape.requests, [100, 150], "refused once with the first endpoint's bound, then asked with its own");
  assert.equal(tape.host, "b.example");
  const openings = await run((chain) => chain.repoOpenings(G, 100));
  assert.deepEqual([...openings.result.openings.keys()], [5]);
  assert.deepEqual(openings.requests, [100, 150]);
});

test("every move between endpoints is told in a sentence", () => {
  assert.equal(rpcChangeText({ from: "a.example", to: "b.example", reason: "timeout" }), "RPC a.example did not answer in time: switched to b.example.");
  assert.equal(rpcChangeText({ from: "a.example", to: "b.example", reason: "error" }), "RPC a.example failed: switched to b.example.");
  assert.equal(rpcChangeText({ from: "a.example", to: "b.example", reason: "behind", behind: 87 }), "RPC a.example is 87 ledgers behind: switched to b.example.");
  assert.equal(rpcChangeText({ from: "b.example", to: "a.example", reason: "level" }), "RPC a.example has caught up: switched back to it.");
});
