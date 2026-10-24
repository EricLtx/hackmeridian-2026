// The terminal draws each panel on its own: a value one panel cannot show
// blanks that panel only, never the whole screen (WEB-5). No network and no
// browser: a stand-in chain and a small stand-in DOM.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTerminal } from "../src/terminal.js";

const dep = JSON.parse(readFileSync(new URL("../public/deployment.testnet.json", import.meta.url), "utf8"));
const G = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
const NOW = 1_792_500_000;

/** Just enough of an element for the terminal's rendering. */
function element(id = "") {
  return {
    id,
    textContent: "",
    innerHTML: "",
    value: "",
    placeholder: "",
    className: "",
    dataset: {},
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    appendChild(node) {
      this.children.push(node);
    },
    remove() {},
    addEventListener() {},
    focus() {},
    setSelectionRange() {},
    scrollIntoView() {},
  };
}

/** A complete open repo as the chain returns it, `fields` overriding. */
const repoOf = (fields = {}) => ({
  id: 1,
  offer_id: 1,
  borrower: G,
  lender: G,
  fund: dep.contracts.fundShares,
  shares: 10_000_000_000n,
  principal: 9_000_000_000n,
  stablecoin: dep.contracts.stablecoin,
  rate_bps: 350,
  opened_at: NOW - 3600,
  maturity: NOW + 86_400,
  status: "Open",
  ...fields,
});
const offer = { id: 1, lender: G, stablecoin: dep.contracts.stablecoin, available: 5_000_000_000n, rate_bps: 325, max_term: 604_800n, funds: [dep.contracts.fundShares], sponsor: false };

/**
 * Mounts a terminal on a stand-in chain whose repo scan answers `readRepos`
 * and a stand-in DOM; `run` gets `$` and runs the assertions once the
 * positions panel has drawn its table (or `ready` says the screen is ready).
 */
async function withTerminal(readRepos, run, overrides = {}, ready = ($) => $("t-pos").innerHTML.includes("<table")) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const realDocument = globalThis.document;
  globalThis.document = { createElement: () => element(), querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  const chain = {
    fund: dep.contracts.fundShares,
    rpcInfo: () => ({ host: "first.example", url: "https://first.example", ms: 120, index: 0, count: 2 }),
    explorerTx: (hash) => `https://explorer.example/tx/${hash}`,
    feeds: async () => ({ nav: { value: null }, fx: { value: null } }),
    readRepos,
    repos: async (from) => (await readRepos(from)).repos,
    repo: async (id) => (await readRepos(1)).repos.find((r) => r.id === id) ?? null,
    repoDue: async () => 0n,
    pendingRelease: async () => null,
    contractEvents: async () => ({ events: [], nextLedger: 10 }),
    pendingChanges: async () => ({}),
    ...overrides,
  };
  const S = {
    dep,
    chain,
    board: { funds: [], paused: { value: false }, offers: { value: [offer] } },
    offers: [offer],
    maxTerm: 604_800,
    wallet: null,
    balances: null,
    approved: false,
    history: null,
    version: 4,
    delay: 172_800,
  };
  const terminal = createTerminal({
    S,
    $,
    esc: (value) => String(value),
    now: () => NOW,
    setHTML: (el, html) => {
      el.innerHTML = html;
    },
    runTx: async () => {},
    connect: async () => {},
    refreshAll: async () => {},
    setFace() {},
    fundLimits: () => [],
    onboardCommand: (address) => address,
  });
  try {
    terminal.mount();
    for (let wait = 0; wait < 40 && !ready($); wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await run($, terminal);
  } finally {
    terminal.unmount();
    globalThis.document = realDocument;
  }
}

test("a repo the band cannot add up blanks the band only: the book, the ticket, the positions, the tape and the status still draw", async () => {
  // A repo without its principal, as a hostile or faulty RPC could return it past a weaker check.
  const repo = repoOf();
  delete repo.principal;
  await withTerminal(
    async (from) => ({ repos: from === 1 ? [repo] : [], unreadable: [] }),
    ($) => {
      assert.match($("t-band").innerHTML, /cannot show/, "the band shows that it could not be drawn");
      assert.match($("t-book").innerHTML, /<table/, "the offer book");
      assert.match($("t-ticket").innerHTML, /Start here/, "the ticket");
      assert.match($("t-pos").innerHTML, /<table/, "the positions");
      assert.match($("t-tape").innerHTML, /No event yet/, "the tape");
      assert.match($("t-status").innerHTML, /first\.example/, "the status line");
    },
  );
});

test("a repo the scan could not read is counted in the positions panel, and the market shows the others (WEB-5)", async () => {
  // The scan skipped repo 2 (a field missing) and read repos 1 and 3.
  const readable = [repoOf({ id: 1 }), repoOf({ id: 3, status: "Repurchased" })];
  await withTerminal(
    async (from) => ({ repos: readable.filter((r) => r.id >= from), unreadable: from <= 2 ? [2] : [] }),
    ($) => {
      assert.match($("t-pos").innerHTML, /<table/, "the positions draw");
      assert.match($("t-pos").innerHTML, /#1/, "the readable open repo");
      assert.doesNotMatch($("t-pos").innerHTML, /#2\b/, "the unreadable one is not shown");
      assert.match($("t-pos-meta").textContent, /1 open · 1 repo could not be read$/);
      assert.match($("t-band").innerHTML, /<span/, "the band adds up the readable repos");
      assert.doesNotMatch($("t-band").innerHTML, /cannot show/);
    },
  );
});

test("a tracked open repo whose re-read fails keeps its last reading and is counted, as the guided view counts it (WEB-5)", async () => {
  // The first scan reads repo 1; the next passes start past it, and its own read then fails (a field missing from the answer).
  const repo = repoOf({ id: 1 });
  let reads = 0;
  const warn = mock.method(console, "warn", () => {});
  try {
    await withTerminal(
      async (from) => ({ repos: from === 1 ? [repo] : [], unreadable: [] }),
      async ($, terminal) => {
        assert.match($("t-pos").innerHTML, /#1/);
        assert.doesNotMatch($("t-pos-meta").textContent, /could not be read/);
        await terminal.refresh({ force: true });
        assert.ok(reads >= 1, "the open repo was read again");
        assert.match($("t-pos").innerHTML, /#1/, "its last reading stays");
        assert.match($("t-pos-meta").textContent, /1 open · 1 repo could not be read$/);
        assert.ok(warn.mock.calls.some((c) => /repo #1 could not be read again: missing repo\.principal/.test(c.arguments.join(" "))));
      },
      {
        repo: async () => {
          reads += 1;
          throw new TypeError("missing repo.principal from the chain");
        },
      },
    );
  } finally {
    warn.mock.restore();
  }
});

test("the status band shows an RPC time with decimals: the clock that measures it is fractional", async () => {
  // The endpoint's last answer time comes from a monotonic clock in milliseconds, with decimals.
  await withTerminal(
    async (from) => ({ repos: from === 1 ? [repoOf()] : [], unreadable: [] }),
    ($) => {
      const band = $("t-status").innerHTML;
      assert.match(band, /first\.example/, "the endpoint");
      assert.match(band, /148/, "the time, rounded to the millisecond");
      assert.doesNotMatch(band, /cannot show/, "no unshowable note in place of the status");
    },
    { rpcInfo: () => ({ host: "first.example", url: "https://first.example", ms: 147.7, index: 0, count: 2 }) },
  );
});

test("the tape says it is reading until the first answer, and that there is no event only once it has one", async () => {
  let answer;
  const first = new Promise((resolve) => {
    answer = resolve;
  });
  await withTerminal(
    async () => ({ repos: [], unreadable: [] }),
    async ($) => {
      const before = $("t-tape").innerHTML;
      assert.match(before, /class="t-loading"/, "a loading line, not an empty state");
      assert.match(before, /Reading the latest events…/);
      assert.doesNotMatch(before, /No event yet/, "an unread tape is not an empty one");
      answer({ events: [], nextLedger: 10 });
      for (let wait = 0; wait < 40 && !$("t-tape").innerHTML.includes("No event yet"); wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const after = $("t-tape").innerHTML;
      assert.match(after, /No event yet in the window the RPC keeps\./);
      assert.doesNotMatch(after, /t-loading|Reading the latest events/);
    },
    { contractEvents: () => first },
    // The first render happens on mount, before any read answers.
    () => true,
  );
});

test("the tape says it is reading until an answer, a failed one included", async () => {
  await withTerminal(
    async () => ({ repos: [], unreadable: [] }),
    ($) => {
      assert.match($("t-tape").innerHTML, /Live events unavailable/);
      assert.match($("t-tape").innerHTML, /No event yet/, "a failed read ends the loading state");
      assert.doesNotMatch($("t-tape").innerHTML, /t-loading/);
    },
    {
      contractEvents: async () => {
        throw new Error("events down");
      },
    },
  );
});
