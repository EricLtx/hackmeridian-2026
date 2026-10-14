// Formatting and parsing of on-chain values. Amounts stay BigInt end to end:
// a 7-decimal token amount does not survive a round trip through a float.

/** Parses a decimal string ("1,250.5") into integer units, or null when invalid. */
export function toUnits(text, decimals) {
  const clean = String(text ?? "").replace(/[\s,_]/g, "");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || clean === "" || clean === ".") return null;
  const [, whole = "", fraction = ""] = match;
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
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats integer units with `digits` fraction digits (default all of them).
 * `rounding` is "round" (half up), "floor" or "ceil"; amounts owed are shown
 * rounded up so the screen never promises less than the contract will take.
 */
export function formatUnits(units, decimals, { digits = decimals, rounding = "round" } = {}) {
  const value = BigInt(units);
  const negative = value < 0n;
  const scaled = divide(negative ? -value : value, 10n ** BigInt(decimals - digits), rounding);
  const base = 10n ** BigInt(digits);
  const whole = group((scaled / base).toString());
  const fraction = digits > 0 ? `.${(scaled % base).toString().padStart(digits, "0")}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** A token amount for display: two decimals, grouped. */
export const formatAmount = (units, decimals = 7, rounding = "round") => formatUnits(units, decimals, { digits: 2, rounding });

/** Units back to a plain input string ("1250.5"), no grouping, no trailing zeros. */
export function unitsToInput(units, decimals) {
  const text = formatUnits(units, decimals).replace(/,/g, "");
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** An annual rate in basis points: 250 -> "2.50 %". */
export const formatRate = (bps) => `${formatUnits(BigInt(bps), 2)} %`;

/** A duration in seconds, coarse: "45 s", "12 min", "3 h 05 min", "2 d 4 h". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
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
  if (age < 0) return "just now";
  return `${formatDuration(age)} ago`;
}

/** A term in seconds as hours: 3600 -> "1 hour", 604800 -> "168 hours (7 days)". */
export function formatTerm(seconds) {
  const hours = Math.floor(Number(seconds) / 3600);
  const label = `${hours} hour${hours === 1 ? "" : "s"}`;
  return hours >= 48 && hours % 24 === 0 ? `${label} (${hours / 24} days)` : label;
}

/** A Unix timestamp as a local date and time. */
export function formatDateTime(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** GABC…WXYZ */
export const shortAddress = (address) => (address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "");
