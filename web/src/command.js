// The terminal's command line: short mnemonics typed and confirmed with
// Enter, the GO key of a market terminal. Pure: a line in, a typed command
// out. Quantities become integer token units with the token's decimals, so
// nothing is rounded twice between the screen and the contract.

import { toUnits } from "./format.js";

const HOUR = 3600;

/** Every command, in the order HELP lists them. `name` is what HELP shows; aliases are accepted too. */
export const COMMANDS = [
  { name: "Q", aliases: ["QUOTE"], usage: "Q <shares> [FUND]", help: "value shares now: price, haircut, the most they can secure" },
  { name: "O", aliases: ["OPEN", "BORROW"], usage: "O <offer> <shares> <term> [amount]", help: "ticket to open a repo; the amount defaults to 90 % of the ceiling" },
  { name: "R", aliases: ["REPAY", "REPURCHASE"], usage: "R <repo>", help: "ticket to repurchase: principal and interest now, shares back" },
  { name: "L", aliases: ["LEND"], usage: "L <amount> <rate> <term>", help: "ticket to create an offer (approved lenders only)" },
  { name: "W", aliases: ["WITHDRAW"], usage: "W <offer> [amount|ALL]", help: "ticket to withdraw unlent funds from one of your offers" },
  { name: "S", aliases: ["SEIZE"], usage: "S <repo>", help: "ticket to take the shares of an unpaid repo after its term" },
  { name: "REL", aliases: ["RELEASE"], usage: "REL <repo>", help: "ticket to retry the delivery of shares the issuer held back" },
  { name: "GO", aliases: ["Y", "YES"], usage: "GO, or Enter on an empty line", help: "sign the ticket with the wallet" },
  { name: "CANCEL", aliases: ["N", "NO", "ESC"], usage: "CANCEL, or Esc", help: "drop the ticket" },
  { name: "OFF", aliases: ["OFFERS", "BOOK"], usage: "OFF", help: "the offer book, best rate first" },
  { name: "POS", aliases: ["POSITIONS", "BLOTTER"], usage: "POS [ALL|ME|<address>]", help: "positions: yours, the whole market, or any address, read-only" },
  { name: "FND", aliases: ["FUNDS"], usage: "FND", help: "admitted funds: NAV, age, haircut, capacity" },
  { name: "EV", aliases: ["TAPE", "EVENTS"], usage: "EV", help: "the tape: every contract event, newest first" },
  { name: "CONN", aliases: ["CONNECT"], usage: "CONN", help: "connect Freighter" },
  { name: "REF", aliases: ["REFRESH"], usage: "REF", help: "read the chain again now" },
  { name: "CLR", aliases: ["CLEAR"], usage: "CLR", help: "clear the console" },
  { name: "GUIDE", aliases: [], usage: "GUIDE", help: "back to the guided view" },
  { name: "HELP", aliases: ["?", "H"], usage: "HELP", help: "this list" },
];

/** Notation the parser accepts, for HELP. */
export const NOTATION = [
  "Quantities: 1000, 1,000.50, 5K, 1.5M (K = thousand, M = million).",
  "Terms: 64 or 64H (hours), 2D (days), 1W (weeks); one hour at least.",
  "Rates: 3.25 or 3.25% (a year), or 325BP.",
  "Ids: 7 or #7. Fund tickers as on the FND panel, any case.",
];

const byWord = new Map(COMMANDS.flatMap((c) => [c.name, ...c.aliases].map((w) => [w, c])));

/** The command a first word names, or null. */
export function findCommand(word) {
  return byWord.get(String(word ?? "").toUpperCase()) ?? null;
}

/**
 * Command words that start with what is typed, for Tab completion. Only the
 * first word completes; an exact name returns nothing.
 */
export function completions(text) {
  const raw = String(text ?? "");
  if (/\s/.test(raw.trimStart())) return [];
  const up = raw.trim().toUpperCase();
  if (!up || byWord.has(up)) return [];
  return [...byWord.keys()].filter((w) => w.startsWith(up)).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** A quantity in units: "1,000.5", "5K", "1.5M". Null when invalid or not positive. */
export function quantity(text, decimals) {
  const match = /^([0-9][0-9,]*(?:\.[0-9]*)?|\.[0-9]+)([KM]?)$/i.exec(String(text ?? ""));
  if (!match) return null;
  const base = toUnits(match[1], decimals);
  if (base === null) return null;
  const scale = { "": 1n, K: 1_000n, M: 1_000_000n }[match[2].toUpperCase()];
  const units = base * scale;
  return units > 0n ? units : null;
}

/** A term in seconds: "64", "64H", "2D", "1W". Null when invalid. */
export function term(text) {
  const match = /^(\d{1,5})([HDW]?)$/i.exec(String(text ?? ""));
  if (!match) return null;
  const n = Number(match[1]);
  if (n < 1) return null;
  const hours = { "": n, H: n, D: n * 24, W: n * 168 }[match[2].toUpperCase()];
  return hours * HOUR;
}

/** An annual rate in basis points: "3.25", "3.25%", "325BP". Null when invalid or above 100 %. */
export function rate(text) {
  const raw = String(text ?? "");
  const bp = /^(\d{1,5})BPS?$/i.exec(raw);
  if (bp) {
    const n = Number(bp[1]);
    return n <= 10_000 ? n : null;
  }
  const pct = /^(\d{1,3}(?:\.\d{0,2})?)%?$/.exec(raw);
  if (!pct) return null;
  const units = toUnits(pct[1], 2);
  return units !== null && units <= 10_000n ? Number(units) : null;
}

/** An offer or repo id: "7" or "#7". */
export function id(text) {
  const match = /^#?(\d{1,15})$/.exec(String(text ?? ""));
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

const ADDRESS = /^[GC][A-Z2-7]{55}$/;

const fail = (error, usage = null) => ({ ok: false, error, usage });
const usageOf = (name) => COMMANDS.find((c) => c.name === name).usage;

/**
 * Parses one line. `ctx`: `{ shareDecimals, stableDecimals, funds }`, funds
 * being the fund tickers the instance admits. Returns `{ ok: true, cmd, ... }`
 * or `{ ok: false, error, usage }`. An empty line is GO, as on a terminal
 * keyboard where Enter confirms the pending ticket.
 */
export function parseCommand(line, ctx = {}) {
  const fd = ctx.shareDecimals ?? 7;
  const sd = ctx.stableDecimals ?? 7;
  const funds = ctx.funds ?? [];
  const words = String(line ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { ok: true, cmd: "go", implicit: true };
  const [head, ...args] = words;
  const spec = findCommand(head);
  if (!spec) return fail(`Unknown command ${head.toUpperCase()}. Type HELP for the list.`);
  const usage = spec.usage;
  const arity = (min, max) => args.length >= min && args.length <= max;

  switch (spec.name) {
    case "Q": {
      if (!arity(1, 2)) return fail("Q needs a number of shares.", usage);
      const shares = quantity(args[0], fd);
      if (shares === null) return fail(`Shares must be a positive number with up to ${fd} decimals.`, usage);
      let fund = null;
      if (args[1]) {
        fund = funds.find((f) => f.toUpperCase() === args[1].toUpperCase()) ?? null;
        if (!fund) return fail(`Unknown fund ${args[1]}.${funds.length ? ` Funds: ${funds.join(", ")}.` : ""}`, usage);
      }
      return { ok: true, cmd: "quote", shares, fund };
    }
    case "O": {
      if (!arity(3, 4)) return fail("O needs an offer, a number of shares and a term.", usage);
      const offerId = id(args[0]);
      if (offerId === null) return fail(`${args[0]} is not an offer number.`, usage);
      const shares = quantity(args[1], fd);
      if (shares === null) return fail(`Shares must be a positive number with up to ${fd} decimals.`, usage);
      const termSecs = term(args[2]);
      if (termSecs === null) return fail(`${args[2]} is not a term. Use hours (64), days (2D) or weeks (1W).`, usage);
      let amount = null;
      if (args[3]) {
        amount = quantity(args[3], sd);
        if (amount === null) return fail(`The amount must be a positive number with up to ${sd} decimals.`, usage);
      }
      return { ok: true, cmd: "open", offerId, shares, termSecs, amount };
    }
    case "R":
    case "S":
    case "REL": {
      if (!arity(1, 1)) return fail(`${spec.name} needs a repo number.`, usage);
      const repoId = id(args[0]);
      if (repoId === null) return fail(`${args[0]} is not a repo number.`, usage);
      return { ok: true, cmd: { R: "repurchase", S: "seize", REL: "release" }[spec.name], repoId };
    }
    case "L": {
      if (!arity(3, 3)) return fail("L needs an amount, a rate and a term.", usage);
      const amount = quantity(args[0], sd);
      if (amount === null) return fail(`The amount must be a positive number with up to ${sd} decimals.`, usage);
      const rateBps = rate(args[1]);
      if (rateBps === null) return fail(`${args[1]} is not a rate. Use 3.25, 3.25% or 325BP, at most 100 %.`, usage);
      const termSecs = term(args[2]);
      if (termSecs === null) return fail(`${args[2]} is not a term. Use hours (168), days (7D) or weeks (1W).`, usage);
      return { ok: true, cmd: "lend", amount, rateBps, termSecs };
    }
    case "W": {
      if (!arity(1, 2)) return fail("W needs an offer number.", usage);
      const offerId = id(args[0]);
      if (offerId === null) return fail(`${args[0]} is not an offer number.`, usage);
      let amount = null;
      if (args[1] && args[1].toUpperCase() !== "ALL") {
        amount = quantity(args[1], sd);
        if (amount === null) return fail(`The amount must be a positive number with up to ${sd} decimals, or ALL.`, usage);
      }
      return { ok: true, cmd: "withdraw", offerId, amount };
    }
    case "POS": {
      if (!arity(0, 1)) return fail("POS takes at most one argument.", usage);
      const arg = args[0]?.toUpperCase();
      if (!arg) return { ok: true, cmd: "positions", scope: "auto" };
      if (arg === "ALL" || arg === "ME") return { ok: true, cmd: "positions", scope: arg.toLowerCase() };
      if (ADDRESS.test(arg)) return { ok: true, cmd: "positions", scope: arg };
      return fail(`${args[0]} is neither ALL, ME nor a Stellar address.`, usage);
    }
    default: {
      if (args.length) return fail(`${spec.name} takes no argument.`, usage);
      const simple = { GO: "go", CANCEL: "cancel", OFF: "offers", FND: "funds", EV: "tape", CONN: "connect", REF: "refresh", CLR: "clear", GUIDE: "guide", HELP: "help" };
      return { ok: true, cmd: simple[spec.name] };
    }
  }
}

export { usageOf };
