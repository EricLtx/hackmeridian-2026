// Formatting and parsing of on-chain values. Amounts stay BigInt end to end:
// a 7-decimal token amount does not survive a round trip through a float.
// Separators, units and dates follow the interface language (i18n.js).

import { locale, numberStyle, t, tk, tn } from "./i18n.js";

/**
 * Parses a decimal string into integer units, or null when invalid. English:
 * "1,250.5" (commas group thousands by threes). French and Spanish:
 * "1 250,5", "1.250,5" or "1250,5" (a comma before the fraction, spaces or
 * dots grouping thousands by threes); a single dot not followed by exactly
 * three digits is read as a decimal point ("1250.5"). Spaces and underscores
 * are ignored in every language.
 */
export function toUnits(text, decimals) {
  const raw = String(text ?? "").replace(/[\s  _]/g, "");
  let match;
  let whole;
  let fraction;
  if (numberStyle().decimal === ".") {
    match = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/.exec(raw);
    if (!match) return null;
    whole = match[1].replace(/,/g, "");
    fraction = match[2] ?? "";
  } else {
    match = /^(\d{1,3}(?:\.\d{3})+|\d*)(?:,(\d*))?$/.exec(raw);
    if (match) {
      whole = match[1].replace(/\./g, "");
      fraction = match[2] ?? "";
    } else {
      match = /^(\d*)\.(\d*)$/.exec(raw);
      if (!match) return null;
      [, whole, fraction] = match;
    }
  }
  if (whole === "" && fraction === "") return null;
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Divides with a chosen rounding, for non-negative values. */
function divide(value, divisor, rounding) {
  const quotient = value / divisor;
  const rest = value % divisor;
  if (rest === 0n) return quotient;
  if (rounding === "ceil") return quotient + 1n;
  if (rounding === "round") return rest * 2n >= divisor ? quotient + 1n : quotient;
  return quotient;
}

function group(digits) {
  const { group: separator, minGroup } = numberStyle();
  return digits.length < minGroup ? digits : digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** Most decimals a value may carry: a larger count, from a feed or an RPC, would freeze the page in a power of ten. */
export const MAX_DECIMALS = 38;

/** What a tile, a row or a line says in place of a value it cannot format. */
export const UNSHOWABLE = tk("The chain returned a value this page cannot show.");

/** A count of decimals or digits as an integer from 0 to MAX_DECIMALS, or a RangeError. */
function places(count, what) {
  const n = typeof count === "bigint" || (typeof count === "string" && /^\d{1,2}$/.test(count)) ? Number(count) : count;
  if (!Number.isInteger(n) || n < 0 || n > MAX_DECIMALS) throw new RangeError(`${what} out of range: ${String(count).slice(0, 24)}`);
  return n;
}

/**
 * Formats integer units with `digits` fraction digits (default all of them).
 * `rounding` is "round" (half up), "floor" or "ceil"; amounts owed are shown
 * rounded up so the screen never promises less than the contract will take.
 * `decimals` and `digits` are integers from 0 to 38; more digits than the
 * value has pad it with zeros (a 2-decimal price shown with 4 digits).
 */
export function formatUnits(units, decimals, { digits = decimals, rounding = "round" } = {}) {
  const d = places(decimals, "decimals");
  const shown = places(digits, "digits");
  const value = BigInt(units);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  // Scale up when more digits are asked than the value has: never a negative power of ten.
  const scaled = shown >= d ? magnitude * 10n ** BigInt(shown - d) : divide(magnitude, 10n ** BigInt(d - shown), rounding);
  const base = 10n ** BigInt(shown);
  const whole = group((scaled / base).toString());
  const fraction = shown > 0 ? `${numberStyle().decimal}${(scaled % base).toString().padStart(shown, "0")}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** A token amount for display: two decimals, grouped. */
export const formatAmount = (units, decimals = 7, rounding = "round") => formatUnits(units, decimals, { digits: 2, rounding });

/** Units back to a plain input string ("1250.5", "1250,5" in French), no grouping, no trailing zeros. */
export function unitsToInput(units, decimals) {
  const value = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toString();
  const fraction = decimals > 0 ? (value % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return fraction ? `${whole}${numberStyle().decimal}${fraction}` : whole;
}

/** An annual rate in basis points: 250 -> "2.50 %" ("2,50 %" in French). */
export const formatRate = (bps) => `${formatUnits(BigInt(bps), 2)} %`;

/** A duration in seconds, coarse: "45 s", "12 min", "3 h 05 min", "2 d 4 h". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return t("{s} s", { s });
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return t("{m} min", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("{h} h {mm} min", { h: hours, mm: String(minutes % 60).padStart(2, "0") });
  const days = Math.floor(hours / 24);
  return hours % 24 ? t("{d} d {h} h", { d: days, h: hours % 24 }) : t("{d} d", { d: days });
}

/** A countdown in seconds, precise: "1 h 04 min 09 s". */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(rest).padStart(2, "0");
  if (h >= 48) return formatDuration(s);
  return h ? `${h} h ${mm} min ${ss} s` : `${m} min ${ss} s`;
}

/** How long ago a Unix timestamp was, against `now` (Unix seconds). */
export function formatAge(timestamp, now) {
  const age = Number(now) - Number(timestamp);
  if (age < 0) return t("just now");
  return t("{duration} ago", { duration: formatDuration(age) });
}

/** A term in seconds as hours: 3600 -> "1 hour", 604800 -> "168 hours (7 days)". */
export function formatTerm(seconds) {
  const hours = Math.floor(Number(seconds) / 3600);
  const label = tn("{n} hour", "{n} hours", hours);
  return hours >= 48 && hours % 24 === 0 ? t("{hours} ({days} days)", { hours: label, days: hours / 24 }) : label;
}

/** A Unix timestamp as a local date and time, in the interface language. */
export function formatDateTime(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleString(locale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** GABC…WXYZ */
export const shortAddress = (address) => (address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "");
