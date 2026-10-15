// Live Open Window demo on Stellar testnet.
//
//   npm run demo                    every scene, Enter between scenes
//   npm run demo -- --auto          no pauses (rehearsal, recording)
//   npm run demo -- --only=open,repurchase
//   npm run status                  the board only
//   npm run demo -- --only=repair   put the demo back in a clean state
//
// Scenes: board, open, guardrails, repurchase, seize, value; repair on demand.
// Prerequisite: `npm run setup`, at least one hour earlier for the seizure.
//
// Figures come from the chain at that moment: feeds, fund settings, offers,
// balances, latencies and fees. Two are computed here: the weekend cost, with
// the contract's own interest formula, and the bank-route comparison of the
// value scene, from a cut-off time (defaults below, optional override in
// private/demo/value-panel.json).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  ContractError,
  ONE,
  REFLECTOR_FX_TESTNET,
  ROOT,
  asset,
  explorer,
  fmt,
  invoke,
  keypair,
  ledgerTime,
  loadState,
  probe,
  read,
  saveState,
  sleep,
  sv,
} from "./lib.mjs";
import { navAt } from "./config.mjs";

const args = process.argv.slice(2);
const AUTO = args.includes("--auto");
const STATUS = args.includes("--status");
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");

const SCENES = ["board", "open", "guardrails", "repurchase", "seize", "value"];
const SECONDS_PER_YEAR = 365n * 86_400n;
/** Shares the borrower pledges live, and the share of the maximum it borrows. */
const LIVE_SHARES = 10_000n * ONE;
const LIVE_BORROW_BPS = 9_000n;

const state = loadState();
if (!state.contracts?.openWindow) {
  console.error("No deployment found: run `npm run setup` first.");
  process.exit(1);
}
const C = state.contracts;
/** FX feed the fund was admitted with: Reflector, or the local fallback feed. */
const FX_ORACLE = state.fxSource === "local" ? C.navOracle : REFLECTOR_FX_TESTNET;
const pub = (role) => keypair(state, role).publicKey();
/** What the run did on chain, for the value scene. */
const ledger = { txs: [], refusals: [] };

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const line = (label, value) => console.log(`  ${label.padEnd(36)} ${value}`);
const price14 = (p) => (Number(p) / 1e14).toFixed(4);
const pct = (bps) => `${Number(bps) / 100} %`;
const age = (seconds) =>
  seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;

function title(text) {
  console.log(`\n${bold(`━━ ${text} `.padEnd(78, "━"))}`);
}

function alarm(text, fix) {
  console.log(`\n  ${red(bold(`!! ${text}`))}`);
  console.log(`  ${bold(`   Fix: ${fix}`)}`);
}

async function pause(next) {
  if (AUTO || STATUS) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(dim(`\n  ⏎ ${next}`));
  rl.close();
}

/** Sends a transaction, prints its latency and link, and records it. */
async function tx(label, role, contract, fn, fnArgs) {
  process.stdout.write(`  ${label} … `);
  try {
    const result = await invoke(state, role, contract, fn, fnArgs);
    const fee = result.fee === null ? "" : `, fee ${(Number(result.fee) / 1e7).toFixed(4)} XLM`;
    console.log(green(`confirmed in ${result.seconds.toFixed(1)} s`) + dim(` (${result.total.toFixed(1)} s with simulation${fee})`));
    console.log(dim(`    ${explorer(result.hash)}`));
    ledger.txs.push({ label, fn, ...result });
    return result;
  } catch (error) {
    console.log(red("not done"));
    throw error;
  }
}

/** Simulates a call that must be refused, and shows the contract's error. */
async function refused(label, role, contract, fn, fnArgs, expected) {
  const error = await probe(state, role, contract, fn, fnArgs);
  if (error && error.name === expected) {
    console.log(`  ${label.padEnd(48)} ${red(`refused: ${error.name}`)}`);
    ledger.refusals.push(expected);
    return true;
  }
  const got = error ? error.message : "accepted";
  console.log(`  ${label.padEnd(48)} ${bold(`expected ${expected}, got ${got}`)}`);
  return false;
}

/** Simulates a call that must go through. */
async function allowed(label, role, contract, fn, fnArgs) {
  const error = await probe(state, role, contract, fn, fnArgs);
  console.log(`  ${label.padEnd(48)} ${error ? red(`refused: ${error.message}`) : green("still allowed")}`);
  return !error;
}

/** Retries a cleanup transaction: on stage, a failed cleanup must not go unnoticed. */
async function cleanup(label, role, contract, fn, fnArgs) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await tx(label, role, contract, fn, fnArgs);
    } catch (error) {
      console.log(dim(`    attempt ${attempt}: ${error.message}`));
      await sleep(2000 * attempt);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

const balance = (token, who) => read(state, token, "balance", [sv.address(who)]);
const isPaused = () => read(state, C.openWindow, "is_paused");
const getRepo = (id) => read(state, C.openWindow, "get_repo", [sv.u64(id)]);

/** A unit enum variant decodes as `["Open"]`; accept a bare string too. */
const statusOf = (repo) => (Array.isArray(repo.status) ? repo.status[0] : repo.status);

/** Interest the contract charges: actual/365, per started hour, at least one hour. */
function interestFor(principal, rateBps, seconds) {
  const hours = (BigInt(Math.max(seconds, 1)) + 3599n) / 3600n;
  const charged = hours * 3600n;
  const numerator = BigInt(principal) * BigInt(rateBps) * charged;
  const denominator = 10_000n * SECONDS_PER_YEAR;
  return (numerator + denominator - 1n) / denominator;
}

/** The NAV the operator publishes now: the setup NAV grown at the demo yield. */
const navNow = (now) => navAt(state.navPublishedAt ?? now, now);

/** The fund's settings as admitted on chain (two-key `set_fund`). */
async function fundSettings() {
  const config = await read(state, C.openWindow, "get_fund", [sv.address(C.shares)]);
  const fx = Array.isArray(config.source) && config.source[0] === "Cross" ? config.source[1] : null;
  return { config, fx };
}

/**
 * Operator heartbeat: publishes the day's NAV when the last one is over an
 * hour old or differs from the expected NAV by more than 0.1 % (a wrong NAV
 * left by an interrupted scene). With the local FX fallback, re-stamps the
 * last EUR/USD rate as a real operator would.
 */
async function heartbeat() {
  const now = await ledgerTime();
  const expected = navNow(now);
  const nav = await read(state, C.navOracle, "lastprice", [asset.stellar(C.shares)]);
  const drift = nav ? (BigInt(nav.price) - expected) * 1000n / expected : 1n;
  if (!nav || now - Number(nav.timestamp) >= 3600 || drift !== 0n) {
    await tx("Operator publishes today's NAV", "operator", C.navOracle, "publish", [
      asset.stellar(C.shares),
      sv.i128(expected),
      sv.u64(Math.max(now - 1, Number(nav?.timestamp ?? 0))),
    ]);
  }
  if (state.fxSource !== "local") return;
  const fx = await read(state, C.navOracle, "lastprice", [asset.other("EUR")]);
  if (!fx) throw new Error("local FX feed is empty: rerun `npm run setup -- --fx=local`");
  if (now - Number(fx.timestamp) < 3600) return;
  await tx("Operator re-stamps the local EUR/USD", "operator", C.navOracle, "publish", [
    asset.other("EUR"),
    sv.i128(fx.price),
    sv.u64(Math.max(now - 1, Number(fx.timestamp))),
  ]);
}

/** Stops a scene that needs open entries when the contract is paused. */
async function requireOpen() {
  if (!(await isPaused())) return true;
  alarm("Entries are paused (a previous run did not unpause).", "npm run demo -- --only=repair");
  return false;
}

/** Offers that accept the demo fund, sponsor offers first, then by rate. */
async function offers() {
  const list = [];
  for (const id of [state.ids.sponsorOffer, state.ids.marketOffer]) {
    if (id === undefined) continue;
    const offer = await read(state, C.openWindow, "get_offer", [sv.u64(id)]);
    if (offer) list.push({ id, ...offer });
  }
  return list.sort((a, b) => Number(b.sponsor) - Number(a.sponsor) || a.rate_bps - b.rate_bps);
}

const quote = (shares) =>
  read(state, C.openWindow, "quote", [sv.address(C.shares), sv.i128(shares), sv.address(C.euro)]);

// ---------------------------------------------------------------------------
// Business calendar (value scene)
// ---------------------------------------------------------------------------

function valueSettings() {
  const defaults = { cutoff: "12:00", settlementBusinessDays: 1, timeZone: "Europe/Paris", notes: [] };
  const file = path.join(ROOT, "private", "demo", "value-panel.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return defaults;
  }
  try {
    return { ...defaults, ...JSON.parse(text) };
  } catch (error) {
    console.log(red(`  value-panel.json ignored, invalid JSON: ${error.message}`));
    return defaults;
  }
}

/** Wall-clock parts of instant `date` in `timeZone`, as a UTC Date carrying those parts. */
function wallClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

/** The instant a wall-clock time in `timeZone` stands for (inverse of `wallClock`, DST included). */
function instant(wall, timeZone) {
  let guess = new Date(wall);
  for (let i = 0; i < 2; i += 1) guess = new Date(wall - (wallClock(guess, timeZone) - guess));
  return guess;
}

const isBusinessDay = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
const dayName = (d) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Earliest cash through a fund redemption, from wall-clock time `local`: the
 * order counts on the first business day whose cut-off is still ahead, cash
 * arrives N business days later at 09:00. Public holidays are ignored, so this
 * is the optimistic bound. Hours are between instants, so a DST change counts.
 */
function bankRoute(local, settings) {
  const [h, m] = settings.cutoff.split(":").map(Number);
  const order = new Date(local);
  const beforeCutoff = local.getUTCHours() * 60 + local.getUTCMinutes() < h * 60 + m;
  if (!(isBusinessDay(order) && beforeCutoff)) {
    do order.setUTCDate(order.getUTCDate() + 1);
    while (!isBusinessDay(order));
  }
  const cash = new Date(order);
  for (let left = settings.settlementBusinessDays; left > 0; ) {
    cash.setUTCDate(cash.getUTCDate() + 1);
    if (isBusinessDay(cash)) left -= 1;
  }
  cash.setUTCHours(9, 0, 0, 0);
  const hours = (instant(cash, settings.timeZone) - instant(local, settings.timeZone)) / 3_600_000;
  return { local, order, cash, hours };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

async function board() {
  title("Board: what the contract sees right now");
  await heartbeat();
  const now = await ledgerTime();
  const local = wallClock(new Date(now * 1000), "Europe/Paris");
  const weekend = !isBusinessDay(local);
  line("Ledger time (Paris)", `${dayName(local)} ${local.toISOString().slice(11, 16)}${weekend ? bold("  weekend") : ""}`);

  const { config, fx: fxLeg } = await fundSettings();
  const fx = await read(state, FX_ORACLE, "lastprice", [asset.other("EUR")]);
  const nav = await read(state, C.navOracle, "lastprice", [asset.stellar(C.shares)]);
  const fundState = await read(state, C.openWindow, "get_fund_state", [sv.address(C.shares)]);
  if (!fx || !nav || !fundState) {
    alarm("A feed or the fund state is missing.", "npm run setup (resumes), or --fx=local if Reflector is down");
    return;
  }
  const fxLabel = state.fxSource === "local" ? "local fallback, re-stamped by the operator" : "Reflector";
  if (fxLeg) {
    line(`EUR/USD (${fxLabel})`, `${price14(fx.price)}  ${dim(`age ${age(now - Number(fx.timestamp))}, max ${age(Number(fxLeg.max_age_secs))}, band ±${pct(fxLeg.band_bps)} around ${price14(fundState.reference_fx)}`)}`);
  }
  line("Fund share NAV, operator feed", `${price14(nav.price)} USD  ${dim(`age ${age(now - Number(nav.timestamp))}, max ${age(Number(config.nav_max_age_secs))}`)}`);
  line("NAV reference (model path)", `${price14(fundState.reference_nav)} USD  ${dim(`floor ${pct(config.corridor_floor_bps)}, growth ≤ ${pct(config.max_yield_bps)}/yr`)}`);

  const q = await quote(LIVE_SHARES);
  line(`Quote for ${fmt(LIVE_SHARES, 7, 0)} shares`, `${fmt(q.price, Number(q.price_decimals), 4)} EUR/share, haircut ${pct(q.haircut_bps)}, up to ${bold(`${fmt(q.max_principal)} tEUR`)}`);
  line("Outstanding / fund cap", `${fmt(fundState.outstanding)} / ${fmt(config.max_outstanding)} tEUR, ${fmt(config.max_principal_per_repo)} per repo`);

  for (const offer of await offers()) {
    line(`Offer #${offer.id} ${offer.sponsor ? "designated" : "market"}`, `${fmt(offer.available)} tEUR available at ${(offer.rate_bps / 100).toFixed(2)} %`);
  }
  line("Entries", (await isPaused()) ? red("paused") : green("open"));
  for (const [label, id] of [["Live repo", state.ids.liveRepo], ["Staged repo", state.ids.stagedRepo]]) {
    if (id === undefined) continue;
    const repo = await getRepo(id);
    const left = Number(repo.maturity) - now;
    line(`${label} #${id}`, `${statusOf(repo)}, ${left > 0 ? `matures in ${age(left)}` : "matured"}`);
  }
}

async function open() {
  title("Open: shares in, euros out, one transaction");
  if (!(await requireOpen())) return;
  if (state.ids.liveRepo !== undefined && statusOf(await getRepo(state.ids.liveRepo)) === "Open") {
    alarm(`Repo #${state.ids.liveRepo} from an earlier run is still open.`, "npm run demo -- --only=repurchase");
    return;
  }
  await heartbeat();
  const q = await quote(LIVE_SHARES);
  const principal = ((BigInt(q.max_principal) * LIVE_BORROW_BPS) / 10_000n / ONE) * ONE;
  const [offer] = (await offers()).filter((o) => BigInt(o.available) >= principal);
  if (!offer) {
    alarm("No offer has enough funds left.", "npm run setup -- --fresh");
    return;
  }
  const shares = BigInt(await balance(C.shares, pub("borrower")));
  if (shares < LIVE_SHARES) {
    alarm(`The borrower holds ${fmt(shares, 7, 0)} shares, fewer than ${fmt(LIVE_SHARES, 7, 0)}.`, "npm run setup -- --fresh");
    return;
  }
  const term = 3 * 24 * 3600;
  line("Borrower pledges", `${fmt(LIVE_SHARES, 7, 0)} fund shares`);
  line("Offer used", `#${offer.id}${offer.sponsor ? " (designated by the issuer, funded by an independent lender)" : " (market offer)"} at ${(offer.rate_bps / 100).toFixed(2)} %`);
  line("Borrows", `${fmt(principal)} tEUR, ${LIVE_BORROW_BPS / 100n} % of the ${fmt(q.max_principal)} allowed, term ${term / 3600} h`);

  const before = await balance(C.euro, pub("borrower"));
  const opened = await tx("open_repo", "borrower", C.openWindow, "open_repo", [
    sv.address(pub("borrower")),
    sv.u64(offer.id),
    sv.address(C.shares),
    sv.i128(LIVE_SHARES),
    sv.i128(principal),
    sv.u64(term),
  ]);
  state.ids.liveRepo = Number(opened.value);
  saveState(state);
  const after = await balance(C.euro, pub("borrower"));
  line("Borrower tEUR balance", `${fmt(before)} → ${bold(fmt(after))}`);
  line("Shares held by the contract", fmt(await balance(C.shares, C.openWindow), 7, 0));
  const weekend = interestFor(principal, offer.rate_bps, 64 * 3600);
  line("Weekend cost, Fri 17:00 to Mon 09:00", `${fmt(weekend)} tEUR (64 h at ${(offer.rate_bps / 100).toFixed(2)} %)`);
}

async function guardrails() {
  title("Guardrails: what the contract refuses");
  if (!(await requireOpen())) return;
  await heartbeat();
  const ow = C.openWindow;
  const q = await quote(LIVE_SHARES);
  const offerId = sv.u64(state.ids.sponsorOffer);
  const openArgs = (principal) => [
    sv.address(pub("borrower")),
    offerId,
    sv.address(C.shares),
    sv.i128(LIVE_SHARES),
    sv.i128(principal),
    sv.u64(24 * 3600),
  ];

  console.log(dim("\n  1. Borrowing above the haircut-adjusted value"));
  await refused(`open_repo for ${fmt(BigInt(q.max_principal) + ONE)} tEUR`, "borrower", ow, "open_repo", openArgs(BigInt(q.max_principal) + ONE), "LoanTooLarge");

  console.log(dim("\n  2. A faulty NAV feed: +3 % in one tick, impossible for a money market fund"));
  const now = await ledgerTime();
  const good = navNow(now);
  try {
    await tx("Operator publishes a wrong NAV", "operator", C.navOracle, "publish", [asset.stellar(C.shares), sv.i128((good * 103n) / 100n), sv.u64(now - 1)]);
    await refused("open_repo against the wrong NAV", "borrower", ow, "open_repo", openArgs(ONE * 1_000n), "PriceOutOfBand");
    await refused("refresh_reference by anyone", "borrower", ow, "refresh_reference", [sv.address(C.shares)], "PriceOutOfBand");
  } finally {
    // No network call before the republish. `now` is the close time of a past
    // ledger: newer than the wrong NAV (now - 1), never in the future.
    await cleanup("Operator republishes the right NAV", "operator", C.navOracle, "publish", [asset.stellar(C.shares), sv.i128(good), sv.u64(now)]);
    const live = await read(state, C.navOracle, "lastprice", [asset.stellar(C.shares)]).catch(() => null);
    if (!live || BigInt(live.price) !== good) alarm("The wrong NAV may still be live.", "npm run demo -- --only=repair");
  }

  console.log(dim("\n  3. The guardian pauses entries; exits stay open"));
  try {
    await tx("Guardian pauses", "guardian", ow, "pause", [sv.address(pub("guardian"))]);
    await refused("open_repo while paused", "borrower", ow, "open_repo", openArgs(ONE * 1_000n), "Paused");
    if (state.ids.liveRepo !== undefined && statusOf(await getRepo(state.ids.liveRepo)) === "Open") {
      await allowed(`repurchase of repo #${state.ids.liveRepo} while paused`, "borrower", ow, "repurchase", [sv.u64(state.ids.liveRepo)]);
    }
  } finally {
    await cleanup("Governor unpauses", "governor", ow, "unpause", []);
    if (await isPaused().catch(() => true)) alarm("Entries are still paused.", "npm run demo -- --only=repair");
  }
}

async function repurchase() {
  title("Repurchase: euros back with interest, shares back");
  const repoId = state.ids.liveRepo;
  const repo = repoId === undefined ? null : await getRepo(repoId);
  if (!repo || statusOf(repo) !== "Open") {
    console.log(`  No open live repo${repo ? ` (repo #${repoId} is ${statusOf(repo)})` : ""}: run the open scene first.`);
    return;
  }
  const id = sv.u64(repoId);
  const interest = BigInt(await read(state, C.openWindow, "repo_due", [id]));
  const due = BigInt(repo.principal) + interest;
  const now = await ledgerTime();
  line(`Repo #${repoId}`, `${fmt(repo.principal)} tEUR for ${fmt(repo.shares, 7, 0)} shares, open ${age(now - Number(repo.opened_at))}`);
  line("Due now", `${fmt(due, 7, 4)} tEUR, of which interest ${fmt(interest, 7, 4)} (per started hour, one at least)`);
  const offerBefore = await read(state, C.openWindow, "get_offer", [sv.u64(repo.offer_id)]);
  const sharesBefore = await balance(C.shares, pub("borrower"));
  await tx("repurchase", "borrower", C.openWindow, "repurchase", [id]);
  delete state.ids.liveRepo;
  saveState(state);
  const offerAfter = await read(state, C.openWindow, "get_offer", [sv.u64(repo.offer_id)]);
  line("Borrower shares", `${fmt(sharesBefore, 7, 0)} → ${bold(fmt(await balance(C.shares, pub("borrower")), 7, 0))}`);
  line(`Offer #${repo.offer_id} available`, `${fmt(offerBefore.available)} → ${bold(fmt(offerAfter.available))} (principal and interest back in the offer)`);
}

async function seize() {
  title("Default: the lender takes the shares at maturity");
  if (state.ids.stagedRepo === undefined) {
    console.log("  No staged repo: run `npm run setup -- --restage` one hour before.");
    return;
  }
  const id = sv.u64(state.ids.stagedRepo);
  const repo = await getRepo(state.ids.stagedRepo);
  const status = statusOf(repo);
  if (status !== "Open") {
    console.log(`  Repo #${state.ids.stagedRepo} is ${status}: run \`npm run setup -- --restage\` for a new one.`);
    return;
  }
  const now = await ledgerTime();
  line(`Repo #${state.ids.stagedRepo}`, `${fmt(repo.principal)} tEUR against ${fmt(repo.shares, 7, 0)} shares, not repaid`);
  if (now < Number(repo.maturity)) {
    await refused("seize before maturity", "lender", C.openWindow, "seize", [id, sv.address(pub("lender"))], "NotMatured");
    line("Matures in", age(Number(repo.maturity) - now));
    return;
  }
  await refused("seize to an address the issuer has not approved", "lender", C.openWindow, "seize", [id, sv.address(pub("guardian"))], "LenderNotApproved");
  const before = await balance(C.shares, pub("lender"));
  await tx("seize", "lender", C.openWindow, "seize", [id, sv.address(pub("lender"))]);
  line("Lender shares", `${fmt(before, 7, 0)} → ${bold(fmt(await balance(C.shares, pub("lender")), 7, 0))}`);
}

async function value() {
  title("Value: the same need through the bank route");
  const settings = valueSettings();
  const now = wallClock(new Date((await ledgerTime()) * 1000), settings.timeZone);
  const route = bankRoute(now, settings);
  line("Now (Paris)", `${dayName(route.local)} ${route.local.toISOString().slice(11, 16)}`);
  line("Redemption order counts on", `${dayName(route.order)} (cut-off ${settings.cutoff})`);
  line("Earliest cash, bank route", `${dayName(route.cash)} ~09:00, about ${Math.round(route.hours)} h from now`);
  const openTx = ledger.txs.find((t) => t.fn === "open_repo");
  line("Cash through Open Window", openTx ? bold(`${openTx.seconds.toFixed(1)} s, measured above`) : "one ledger, about 5 s");
  if (ledger.txs.length) {
    const fees = ledger.txs.reduce((sum, t) => sum + (t.fee ?? 0n), 0n);
    line("Transactions this run", `${ledger.txs.length}, network fees ${(Number(fees) / 1e7).toFixed(4)} XLM in total`);
  }
  if (ledger.refusals.length) line("Refusals shown", [...new Set(ledger.refusals)].join(", "));

  // The same comparison at four moments of next week, in Paris time.
  console.log(dim("\n  When the need arises             bank route, earliest cash     Open Window"));
  const monday = new Date(route.local);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + 7);
  const moments = [
    ["Monday 10:00, before cut-off", 0, 10],
    ["Monday 15:00, after cut-off", 0, 15],
    ["Friday 17:00, weekend ahead", 4, 17],
    ["Saturday 11:00", 5, 11],
  ];
  const seconds = openTx ? `${openTx.seconds.toFixed(0)} s` : "~5 s";
  for (const [label, offset, hour] of moments) {
    const at = new Date(monday);
    at.setUTCDate(monday.getUTCDate() + offset);
    at.setUTCHours(hour, 0, 0, 0);
    const r = bankRoute(at, settings);
    console.log(`  ${label.padEnd(32)} ${`${dayName(r.cash)}, ~${Math.round(r.hours)} h`.padEnd(29)} ${seconds}, any hour`);
  }
  if (settings.roi) await roiPanel(settings.roi);
  for (const note of settings.notes) console.log(`  ${note}`);
  console.log(dim("\n  Public holidays are ignored: the bank route can only be longer."));
}

/**
 * Return on investment, computed with the contract's own interest rule at the
 * rates of the live offers and at the scenario rates of the business case.
 * Every assumption (reserve, fund yield, amount borrowed, how often) comes
 * from the private settings file; nothing about the business case is in the
 * repository. A line is checked against the simple-interest model the
 * business case uses: at whole hours they must agree to the cent.
 */
async function roiPanel(roi) {
  const unit = 10n ** 7n;
  const toUnits = (euros) => BigInt(Math.round(euros)) * unit;
  const euros = (units) => Number(units) / 1e7;
  const hours = roi.weekendHours ?? 64;
  const borrow = toUnits(roi.borrow);
  const yearly = roi.reserve * roi.fundYield;
  const rates = [
    ...(await offers()).map((o) => [`offer #${o.id}${o.sponsor ? " sponsor" : ""}, on chain`, o.rate_bps]),
    ...Object.entries(roi.scenarioRates ?? {}).map(([name, r]) => [`scenario ${name}`, Math.round(r * 10_000)]),
  ];
  console.log(dim(`\n  Return for a treasurer: reserve ${fmtEur(roi.reserve)} kept in the fund at ${(roi.fundYield * 100).toFixed(2)} % (${fmtEur(yearly)} a year), ${fmtEur(roi.borrow)} borrowed for ${hours} h when needed`));
  console.log(dim(`  ${"Rate".padEnd(36)} ${"weekend cost".padStart(13)} ${"model".padStart(9)} ${roi.weekendsPerYear.map((n) => `net, ${n}/yr`.padStart(14)).join(" ")}`));
  let mismatches = 0;
  for (const [label, bps] of rates) {
    const cost = euros(interestFor(borrow, bps, hours * 3600));
    const model = roi.borrow * (bps / 10_000) * hours / 8760;
    if (Math.abs(cost - model) > 0.01) mismatches += 1;
    const nets = roi.weekendsPerYear.map((n) => fmtEur(yearly - n * cost).padStart(14));
    console.log(`  ${`${label} ${(bps / 100).toFixed(2)} %`.padEnd(36)} ${fmtEur(cost, 2).padStart(13)} ${fmtEur(model, 2).padStart(9)} ${nets.join(" ")}`);
  }
  console.log(mismatches ? red(`  ${mismatches} line(s) differ from the business-case model`) : green("  Contract interest equals the business-case model on every line"));
}

const fmtEur = (n, digits = 0) => `€${Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** Puts the demo back in a clean state after an interrupted run. */
async function repair() {
  title("Repair");
  if (await isPaused()) await cleanup("Governor unpauses", "governor", C.openWindow, "unpause", []);
  line("Entries", (await isPaused()) ? red("still paused") : green("open"));
  await heartbeat();
  const nav = await read(state, C.navOracle, "lastprice", [asset.stellar(C.shares)]);
  line("NAV", `${price14(nav.price)} USD`);
  if (state.ids.liveRepo !== undefined && statusOf(await getRepo(state.ids.liveRepo)) === "Open") {
    await cleanup(`Borrower repurchases repo #${state.ids.liveRepo}`, "borrower", C.openWindow, "repurchase", [sv.u64(state.ids.liveRepo)]);
  }
  if (state.ids.liveRepo !== undefined && statusOf(await getRepo(state.ids.liveRepo)) !== "Open") {
    delete state.ids.liveRepo;
    saveState(state);
  }
  line("Live repo", state.ids.liveRepo === undefined ? green("none open") : red(`#${state.ids.liveRepo} still open`));
}

// ---------------------------------------------------------------------------

const RUN = { board, open, guardrails, repurchase, seize, value, repair };

async function main() {
  const list = STATUS ? ["board"] : (ONLY ?? SCENES);
  for (const [i, name] of list.entries()) {
    if (!RUN[name]) throw new Error(`unknown scene ${name}; scenes: ${Object.keys(RUN).join(", ")}`);
    await RUN[name]();
    if (i < list.length - 1) await pause(`next: ${list[i + 1]}`);
  }
}

main().catch((error) => {
  const kind = error instanceof ContractError ? "Contract refused" : "Demo stopped";
  console.error(`\n${red(kind)}: ${error.message}`);
  console.error(dim("  Every transaction above marked confirmed has landed; a step marked not done has not."));
  console.error(dim("  Check with `npm run status`, then `npm run demo -- --only=repair` if needed."));
  process.exit(1);
});
