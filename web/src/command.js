// The terminal's command line: short mnemonics typed and confirmed with
// Enter, the GO key of a market terminal. Pure: a line in, a typed command
// out. Quantities become integer token units with the token's decimals, so
// nothing is rounded twice between the screen and the contract. Command
// words are the same in every language; usages, help lines and errors are
// translated where they are shown (i18n.js).

import { toUnits } from "./format.js";
import { LANGS, t, tk } from "./i18n.js";

const HOUR = 3600;

/** Every command, in the order HELP lists them. `name` is what HELP shows; aliases are accepted too. */
export const COMMANDS = [
  { name: "Q", aliases: ["QUOTE"], usage: tk("Q <shares> [FUND]"), help: tk("value shares now: price, haircut, the most they can secure") },
  { name: "O", aliases: ["OPEN", "BORROW"], usage: tk("O <offer> <shares> <term> [amount]"), help: tk("ticket to open a repo; the amount defaults to 90 % of the ceiling") },
  { name: "R", aliases: ["REPAY", "REPURCHASE"], usage: tk("R <repo>"), help: tk("ticket to repurchase: principal and interest now, shares back") },
  { name: "L", aliases: ["LEND"], usage: tk("L <amount> <rate> <term>"), help: tk("ticket to create an offer (approved lenders only)") },
  { name: "W", aliases: ["WITHDRAW"], usage: tk("W <offer> [amount|ALL]"), help: tk("ticket to withdraw unlent funds from one of your offers") },
  { name: "S", aliases: ["SEIZE"], usage: tk("S <repo>"), help: tk("ticket to take the shares of an unpaid repo after its term") },
  { name: "REL", aliases: ["RELEASE"], usage: tk("REL <repo>"), help: tk("ticket to retry the delivery of shares the issuer held back") },
  { name: "GO", aliases: ["Y", "YES"], usage: tk("GO, or Enter on an empty line"), help: tk("sign the ticket with the wallet") },
  { name: "CANCEL", aliases: ["N", "NO", "ESC"], usage: tk("CANCEL, or Esc"), help: tk("drop the ticket") },
  { name: "OFF", aliases: ["OFFERS", "BOOK"], usage: tk("OFF"), help: tk("the offer book, best rate first") },
  { name: "POS", aliases: ["POSITIONS", "BLOTTER"], usage: tk("POS [ALL|ME|<address>]"), help: tk("positions: yours, the whole market, or any address, read-only") },
  { name: "FND", aliases: ["FUNDS"], usage: tk("FND"), help: tk("admitted funds: NAV, age, haircut, capacity") },
  { name: "EV", aliases: ["TAPE", "EVENTS"], usage: tk("EV"), help: tk("the tape: every contract event, newest first") },
  { name: "CONN", aliases: ["CONNECT"], usage: tk("CONN"), help: tk("connect Freighter") },
  { name: "REF", aliases: ["REFRESH"], usage: tk("REF"), help: tk("read the chain again now") },
  { name: "CLR", aliases: ["CLEAR"], usage: tk("CLR"), help: tk("clear the console") },
  { name: "GUIDE", aliases: [], usage: tk("GUIDE"), help: tk("back to the guided view") },
  { name: "LANG", aliases: ["LANGUE", "IDIOMA"], usage: tk("LANG [EN|FR|ES]"), help: tk("show or switch the interface language") },
  { name: "HELP", aliases: ["?", "H", "AIDE", "AYUDA"], usage: tk("HELP"), help: tk("this list") },
];

/**
 * Notation the parser accepts, for HELP. Each language describes its own
 * forms: the decimal comma in French and Spanish, J and S for days and weeks.
 */
export const NOTATION = [
  tk("Quantities: 1000, 1,000.50, 5K, 1.5M (K = thousand, M = million)."),
  tk("Terms: 64 or 64H (hours), 2D (days), 1W (weeks); one hour at least."),
  tk("Rates: 3.25 or 3.25% (a year), or 325BP."),
  tk("Ids: 7 or #7. Fund tickers as on the FND panel, any case."),
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

/**
 * A quantity in units: "1,000.5", "5K", "1.5M" in English; "1000,5" or
 * "1,5M" in French and Spanish (the separators of `toUnits`). Null when
 * invalid or not positive.
 */
export function quantity(text, decimals) {
  const match = /^([0-9.,]+)([KM]?)$/i.exec(String(text ?? ""));
  if (!match) return null;
  const base = toUnits(match[1], decimals);
  if (base === null) return null;
  const scale = { "": 1n, K: 1_000n, M: 1_000_000n }[match[2].toUpperCase()];
  const units = base * scale;
  return units > 0n ? units : null;
}

/** A term in seconds: "64", "64H", "2D" (or 2J), "1W" (or 1S). Null when invalid. */
export function term(text) {
  const match = /^(\d{1,5})([HDJWS]?)$/i.exec(String(text ?? ""));
  if (!match) return null;
  const n = Number(match[1]);
  if (n < 1) return null;
  const hours = { "": n, H: n, D: n * 24, J: n * 24, W: n * 168, S: n * 168 }[match[2].toUpperCase()];
  return hours * HOUR;
}

/** An annual rate in basis points: "3.25", "3.25%" ("3,25" in French and Spanish), "325BP" or "325PB". Null when invalid or above 100 %. */
export function rate(text) {
  const raw = String(text ?? "");
  const bp = /^(\d{1,5})(?:BPS?|PB)$/i.exec(raw);
  if (bp) {
    const n = Number(bp[1]);
    return n <= 10_000 ? n : null;
  }
  const pct = /^(\d{1,3}(?:[.,]\d{0,2})?)%?$/.exec(raw);
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
const usageOf = (name) => t(COMMANDS.find((c) => c.name === name).usage);

/**
 * Parses one line. `ctx`: `{ shareDecimals, stableDecimals, funds }`, funds
 * being the fund tickers the instance admits. Returns `{ ok: true, cmd, ... }`
 * or `{ ok: false, error, usage }`, the error and the usage in the interface
 * language. An empty line is GO, as on a terminal keyboard where Enter
 * confirms the pending ticket.
 */
export function parseCommand(line, ctx = {}) {
  const fd = ctx.shareDecimals ?? 7;
  const sd = ctx.stableDecimals ?? 7;
  const funds = ctx.funds ?? [];
  const words = String(line ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { ok: true, cmd: "go", implicit: true };
  const [head, ...args] = words;
  const spec = findCommand(head);
  if (!spec) return fail(t("Unknown command {word}. Type HELP for the list.", { word: head.toUpperCase() }));
  const usage = t(spec.usage);
  const arity = (min, max) => args.length >= min && args.length <= max;

  switch (spec.name) {
    case "Q": {
      if (!arity(1, 2)) return fail(t("Q needs a number of shares."), usage);
      const shares = quantity(args[0], fd);
      if (shares === null) return fail(t("Shares must be a positive number with up to {decimals} decimals.", { decimals: fd }), usage);
      let fund = null;
      if (args[1]) {
        fund = funds.find((f) => f.toUpperCase() === args[1].toUpperCase()) ?? null;
        if (!fund) {
          return fail(
            funds.length ? t("Unknown fund {fund}. Funds: {list}.", { fund: args[1], list: funds.join(", ") }) : t("Unknown fund {fund}.", { fund: args[1] }),
            usage,
          );
        }
      }
      return { ok: true, cmd: "quote", shares, fund };
    }
    case "O": {
      if (!arity(3, 4)) return fail(t("O needs an offer, a number of shares and a term."), usage);
      const offerId = id(args[0]);
      if (offerId === null) return fail(t("{value} is not an offer number.", { value: args[0] }), usage);
      const shares = quantity(args[1], fd);
      if (shares === null) return fail(t("Shares must be a positive number with up to {decimals} decimals.", { decimals: fd }), usage);
      const termSecs = term(args[2]);
      if (termSecs === null) return fail(t("{value} is not a term. Use hours (64), days (2D) or weeks (1W).", { value: args[2] }), usage);
      let amount = null;
      if (args[3]) {
        amount = quantity(args[3], sd);
        if (amount === null) return fail(t("The amount must be a positive number with up to {decimals} decimals.", { decimals: sd }), usage);
      }
      return { ok: true, cmd: "open", offerId, shares, termSecs, amount };
    }
    case "R":
    case "S":
    case "REL": {
      if (!arity(1, 1)) return fail(t("{command} needs a repo number.", { command: spec.name }), usage);
      const repoId = id(args[0]);
      if (repoId === null) return fail(t("{value} is not a repo number.", { value: args[0] }), usage);
      return { ok: true, cmd: { R: "repurchase", S: "seize", REL: "release" }[spec.name], repoId };
    }
    case "L": {
      if (!arity(3, 3)) return fail(t("L needs an amount, a rate and a term."), usage);
      const amount = quantity(args[0], sd);
      if (amount === null) return fail(t("The amount must be a positive number with up to {decimals} decimals.", { decimals: sd }), usage);
      const rateBps = rate(args[1]);
      if (rateBps === null) return fail(t("{value} is not a rate. Use 3.25, 3.25% or 325BP, at most 100 %.", { value: args[1] }), usage);
      const termSecs = term(args[2]);
      if (termSecs === null) return fail(t("{value} is not a term. Use hours (168), days (7D) or weeks (1W).", { value: args[2] }), usage);
      return { ok: true, cmd: "lend", amount, rateBps, termSecs };
    }
    case "W": {
      if (!arity(1, 2)) return fail(t("W needs an offer number."), usage);
      const offerId = id(args[0]);
      if (offerId === null) return fail(t("{value} is not an offer number.", { value: args[0] }), usage);
      let amount = null;
      if (args[1] && args[1].toUpperCase() !== "ALL") {
        amount = quantity(args[1], sd);
        if (amount === null) return fail(t("The amount must be a positive number with up to {decimals} decimals, or ALL.", { decimals: sd }), usage);
      }
      return { ok: true, cmd: "withdraw", offerId, amount };
    }
    case "POS": {
      if (!arity(0, 1)) return fail(t("POS takes at most one argument."), usage);
      const arg = args[0]?.toUpperCase();
      if (!arg) return { ok: true, cmd: "positions", scope: "auto" };
      if (arg === "ALL" || arg === "ME") return { ok: true, cmd: "positions", scope: arg.toLowerCase() };
      if (ADDRESS.test(arg)) return { ok: true, cmd: "positions", scope: arg };
      return fail(t("{value} is neither ALL, ME nor a Stellar address.", { value: args[0] }), usage);
    }
    case "LANG": {
      if (!arity(0, 1)) return fail(t("LANG takes at most one language code."), usage);
      if (!args[0]) return { ok: true, cmd: "lang", code: null };
      const code = args[0].toLowerCase();
      if (!LANGS.includes(code)) return fail(t("{value} is not a language here. Use EN, FR or ES.", { value: args[0].toUpperCase() }), usage);
      return { ok: true, cmd: "lang", code };
    }
    default: {
      if (args.length) return fail(t("{command} takes no argument.", { command: spec.name }), usage);
      const simple = { GO: "go", CANCEL: "cancel", OFF: "offers", FND: "funds", EV: "tape", CONN: "connect", REF: "refresh", CLR: "clear", GUIDE: "guide", HELP: "help" };
      return { ok: true, cmd: simple[spec.name] };
    }
  }
}

export { usageOf };
