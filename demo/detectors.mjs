// The monitor's decisions, without the chain: the detectors of the
// monitoring plan (docs/threat-model-stride.md, section 3.1) and the choice
// of the automatic actions. Pure functions: a snapshot of the chain comes in,
// alerts go out; alerts and that snapshot come in, the decided actions go
// out. monitor.mjs reads the chain, calls them and sends the transactions.
// Nothing here reads a file, the network or a key, so every rule can be
// tested offline (demo/test/).
//
// A detector may keep a little memory between passes in the `monitor`
// object (a rate unchanged since when, say); monitor.mjs saves it.

/** Thresholds of the monitoring plan. monitor.mjs overrides some from its flags; the rehearsal forces some for a drill. */
export const LIMITS = {
  ttlDays: 14, // an open entry with less time to live is extended
  // The contract code entry is extended long before archival: on mainnet its
  // restore may not fit in one transaction, which would block every exit
  // (threat model DoS.9). Extended in 30-day slices up to 120 days.
  codeTtlDays: 90,
  navWarnHours: 24, // warn two hours before the contract refuses a 26-hour-old NAV
  capWarnRatio: 0.8, // warn when outstanding passes 80 % of a cap
  opensPerHour: 20, // an unusual rate of new repos
  // The FX feed republishes a frozen rate with a fresh timestamp while the
  // market is closed (observed on the testnet feed over a weekend): the
  // contract's age check cannot see it, only the band and the haircut bound
  // it. Warn when the rate has not moved for longer than a weekend.
  fxFrozenHours: 60,
  // A NAV that keeps its value publication after publication passes the age
  // check too. A variable-NAV fund moves every business day; three days
  // without a move spans a weekend. A constant-NAV fund publishes the same
  // value by design: set the threshold to Infinity for it (`--nav-frozen-hours=`).
  navFrozenHours: 72,
  keeperMinXlm: 20, // below this float the keeper cannot pay a month of rent
  rpcLedgerGap: 10, // two RPC endpoints further apart than this are not reading the same chain
};

export const LEDGER_SECS = 5;
/** Largest extension of the code entry in one transaction, in days. */
export const CODE_STEP_DAYS = 30;
/** What the small entries are extended to, in ledgers: about 140 days. */
export const ENTRY_EXTEND_LEDGERS = 2_419_200;

/** Privileged changes: every one of them is reported (Elev.2). */
export const PRIVILEGED = new Set([
  "guardian_changed", "envelope_changed", "fund_set", "fund_removed",
  "stablecoin_set", "stablecoin_removed", "currency_cap_set", "max_term_changed", "fund_limits_set",
  "lender_approval", "fund_frozen", "sponsor_set", "timelock_delay_changed", "fund_change_cancelled",
  "fallback_set", "fallback_cancelled", "fallback_removed", "upgrade_cancelled", "upgraded",
  "reanchored", "reanchor_cancelled", "admin_proposal_cancelled", "release_redirected",
  "sole_lender_set", "lender_attested", "guardian_backup_set", "steward_recovery_cancelled", "steward_recovered",
  "stablecoin_change_cancelled", "sentinel_changed", "migrated",
]);
/** The stored layout version the current code expects (`SCHEMA_VERSION` in lib.rs); an rc2 instance has no `schema_version` function. */
export const EXPECTED_SCHEMA = 2;
/** Proposals that take effect after the time delay: the window to verify and cancel (Elev.2). */
export const PROPOSALS = /_proposed$|_change_proposed$/;
/** The Open Window refusals of a price that pause new entries. */
export const PRICE_REFUSALS = ["PriceOutOfBand", "StalePrice", "NoPrice", "InvalidPrice", "PriceDivergence"];

// ---------------------------------------------------------------------------
// Small helpers, shared with monitor.mjs
// ---------------------------------------------------------------------------

/** A token amount with `decimals` digits, for messages. */
export function units(amount, decimals = 7, digits = 2) {
  const value = Number(BigInt(amount)) / 10 ** decimals;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const labelOf = (funds, shares) => funds.find((f) => f.shares === shares)?.label ?? `fund ${String(shares).slice(0, 6)}`;
/** Fund label appended to a message when several funds are watched; nothing with one. */
export const tag = (s, f) => (s.funds.length > 1 ? ` [${f.label}]` : "");
export const statusOf = (repo) => (Array.isArray(repo.status) ? repo.status[0] : repo.status);
export const hex = (bytes) => (bytes ? Buffer.from(bytes).toString("hex") : "");
/** Every (fund, lender) pair an exit may read: the lenders of live offers on each fund they list, and of open repos. */
export function lenderPairs(liveOffers, openRepos) {
  const pairs = new Map();
  for (const o of liveOffers) for (const fund of o.funds ?? []) pairs.set(`${fund}:${o.lender}`, [String(fund), String(o.lender)]);
  for (const r of openRepos) pairs.set(`${r.fund}:${r.lender}`, [String(r.fund), String(r.lender)]);
  return [...pairs.values()];
}

// ---------------------------------------------------------------------------
// The detectors: each returns alerts { detector, threat, level, message, action }
// ---------------------------------------------------------------------------
//
// `s` is the snapshot monitor.mjs builds, `monitor` the saved monitoring
// state, `ctx` carries the thresholds (`limits`) and the journal memory.

export const DETECTORS = {
  price(s, _monitor, { limits }) {
    const out = [];
    for (const f of s.funds) {
      if (f.priceError && PRICE_REFUSALS.includes(f.priceError.name)) {
        out.push({ level: "critical", message: `the contract refuses the fund price: ${f.priceError.name}${tag(s, f)}`, action: "pause" });
      }
      const ageHours = f.nav ? (s.now - Number(f.nav.timestamp)) / 3600 : Infinity;
      // Warn two hours before the fund's own bound, whatever it is.
      const warnHours = Math.min(limits.navWarnHours, Number(f.config.nav_max_age_secs) / 3600 - 2);
      if (ageHours >= warnHours) {
        out.push({ level: "warning", message: `NAV is ${ageHours.toFixed(1)} h old; the contract refuses it at ${Number(f.config.nav_max_age_secs) / 3600} h${tag(s, f)}`, action: "republish" });
      }
    }
    return out.map((a) => ({ detector: "price", threat: "Tamper.1", ...a }));
  },
  nav(s, monitor, { limits }) {
    // Tamper.1, NAV feed: a value that never moves while its timestamp is
    // refreshed passes the age check, like a frozen FX rate. A variable-NAV
    // fund moves every business day; a constant-NAV fund does not (raise the
    // threshold for it). The corridor floor bounds what a stale value is worth.
    const out = [];
    monitor.navByFund ??= {};
    for (const f of s.funds) {
      if (!f.nav) continue;
      const price = String(f.nav.price);
      const seen = monitor.navByFund[f.shares] ?? {};
      if (seen.price !== price) monitor.navByFund[f.shares] = { price, since: Number(f.nav.timestamp), publications: 1, feedTimestamp: Number(f.nav.timestamp) };
      else monitor.navByFund[f.shares] = { ...seen, publications: seen.publications + (seen.feedTimestamp !== Number(f.nav.timestamp) ? 1 : 0), feedTimestamp: Number(f.nav.timestamp) };
      const tracked = monitor.navByFund[f.shares];
      const frozenHours = (s.now - tracked.since) / 3600;
      const limit = monitor.navFrozenHoursOverride ?? limits.navFrozenHours;
      if (frozenHours < limit) continue;
      out.push({
        detector: "nav", threat: "Tamper.1", level: "warning",
        message: `NAV unchanged for ${frozenHours.toFixed(1)} h over ${tracked.publications} publication(s) while its timestamp is ${((s.now - Number(f.nav.timestamp)) / 60).toFixed(0)} min old: the age check cannot see a frozen feed${tag(s, f)}`,
        action: "verify the fund type (a constant-NAV fund is flat by design) and that the operator publishes; the corridor floor bounds the exposure",
      });
    }
    return out;
  },
  "reference-age"(s) {
    // Tamper.7 (rc5): the NAV corridor grows from the fund's price reference
    // over at most one NAV age bound. A reference older than that bound no
    // longer follows an honest NAV, which the contract refuses once it has
    // outgrown the floor plus that window. Only an opening or
    // `refresh_reference`, which anyone may call, moves the reference along
    // the model; the keeper refreshes it when the NAV is newer.
    const out = [];
    for (const f of s.funds) {
      const referenceTime = Number(f.fundState.reference_time);
      const bound = Number(f.config.nav_max_age_secs);
      const age = s.now - referenceTime;
      if (age <= bound) continue;
      const newer = Boolean(f.nav) && Number(f.nav.timestamp) > referenceTime;
      out.push({
        detector: "reference-age", threat: "Tamper.7", level: "warning",
        message: `price reference is ${(age / 3600).toFixed(1)} h old, beyond the ${(bound / 3600).toFixed(0)} h NAV age bound: the corridor no longer grows with the NAV, and an honest NAV that outgrows it is refused${tag(s, f)}`,
        action: newer ? "refresh_reference" : "no NAV newer than the reference: have the operator publish, then refresh_reference",
        fund: f.shares,
      });
    }
    return out;
  },
  reconciliation(s) {
    // Invariant I2 (v3), per fund: shares held = shares of open repos + shares awaiting release.
    const out = [];
    for (const f of s.funds) {
      const locked = s.openRepos.filter((r) => String(r.fund) === f.shares).reduce((sum, r) => sum + BigInt(r.shares), 0n);
      const awaiting = s.releases.filter((r) => String(r.fund) === f.shares).reduce((sum, r) => sum + BigInt(r.shares), 0n);
      const held = BigInt(f.held);
      for (const r of s.releases.filter((x) => String(x.fund) === f.shares)) {
        out.push({
          detector: "reconciliation", threat: "DoS.5", level: "critical",
          message: `repo #${r.id}: ${units(r.shares, 7, 0)} shares held back, the share token refuses the transfer (issuer freeze or allowlist)${tag(s, f)}`,
          action: "contact the issuer, then release",
        });
      }
      if (held !== locked + awaiting) {
        out.push({ detector: "reconciliation", threat: "DoS.5", level: "critical", message: `contract holds ${units(held, 7, 7)} shares, open repos and releases account for ${units(locked + awaiting, 7, 7)}: ${held - locked - awaiting} units apart (invariant I2)${tag(s, f)}`, action: "pause" });
      }
    }
    return out;
  },
  privileged(s, monitor) {
    const out = s.events
      .filter((e) => PRIVILEGED.has(e.name))
      .map((e) => ({ level: "warning", message: `privileged change ${e.name} at ledger ${e.ledger}`, action: "verify", tx: e.txHash }));
    // A lost-steward recovery takes the fund from its issuer in 30 days: the issuer must know at once.
    for (const e of s.events.filter((ev) => ev.name === "steward_recovery_proposed")) {
      out.push({ level: "critical", message: `steward recovery proposed at ledger ${e.ledger}`, action: "tell the issuer; its steward key cancels it if the key is not lost", tx: e.txHash });
    }
    // A governor handover waits for the delay since version 4; the guardian can veto it meanwhile.
    for (const e of s.events.filter((ev) => ev.name === "admin_proposed" || ev.name === "admin_changed")) {
      out.push({
        level: "critical",
        message: `${e.name === "admin_proposed" ? "governor handover proposed" : "governor changed"} at ledger ${e.ledger}`,
        action: e.name === "admin_proposed" ? "verify with every signer; if unexpected, the guardian vetoes (veto_admin) inside the delay and keys are rotated" : "verify; if unexpected, treat as a key compromise",
        tx: e.txHash,
      });
    }
    for (const f of s.funds.filter((x) => x.stewardBackup === null)) {
      out.push({ level: "warning", message: `the fund's steward has no registered backup: a lost key could never be replaced${tag(s, f)}`, action: "ask the issuer to call set_steward_backup" });
    }
    // The one change the guardian cannot veto: 30 days to react, from now.
    for (const e of s.events.filter((ev) => ev.name === "guardian_change_forced")) {
      out.push({
        level: "critical",
        message: `forced guardian change at ledger ${e.ledger}: the governor (with the trustee's consent, when one is named) replaces the guardian at ${e.data?.eta ? new Date(Number(e.data.eta) * 1000).toISOString().slice(0, 16) : "?"} UTC`,
        action: "veto_forced",
        tx: e.txHash,
      });
    }
    for (const e of s.events.filter((ev) => PROPOSALS.test(ev.name))) {
      // rc4: a stablecoin registration announced beforehand (`--announce-stablecoin=<address>`) is a warning; unannounced, it is cancelled.
      if (e.name === "stablecoin_change_proposed") {
        const token = String(e.topics?.[0] ?? "");
        const known = (monitor.announcedStablecoins ?? []).includes(token);
        out.push({ level: known ? "warning" : "critical", message: `stablecoin registration proposed at ledger ${e.ledger}: ${token.slice(0, 8)}… as ${e.data?.currency ?? "?"}${known ? " (announced)" : " (NOT announced)"}`, action: known ? "verify before it applies" : "cancel stablecoin", token, tx: e.txHash });
        continue;
      }
      const isUpgrade = e.name === "upgrade_proposed";
      const hash = isUpgrade ? hex(e.data?.wasm_hash) : null;
      const announced = isUpgrade && (monitor.announced ?? []).includes(hash);
      out.push({
        level: isUpgrade && !announced ? "critical" : "warning",
        message: `${e.name} at ledger ${e.ledger}${hash ? `, code ${hash.slice(0, 12)}${announced ? " (announced)" : " (NOT announced)"}` : ""}; takes effect at ${e.data?.eta ? new Date(Number(e.data.eta) * 1000).toISOString().slice(11, 19) : "?"} UTC`,
        action: isUpgrade && !announced ? "cancel" : "verify before it applies",
        tx: e.txHash,
      });
    }
    if (monitor.wasmHash && s.wasmHash && monitor.wasmHash !== s.wasmHash) {
      out.push({ level: "critical", message: `contract code changed: ${monitor.wasmHash.slice(0, 12)} to ${s.wasmHash.slice(0, 12)}`, action: "verify" });
    }
    return out.map((a) => ({ detector: "privileged", threat: "Elev.2", ...a }));
  },
  pause(s) {
    const out = s.events
      .filter((e) => e.name === "pause_changed")
      .map((e) => ({ level: "warning", message: `pause set to ${JSON.stringify(e.data?.paused ?? e.data)} at ledger ${e.ledger}`, action: "verify", tx: e.txHash }));
    if (s.paused) out.push({ level: "warning", message: "new entries are paused", action: "governor decides when to unpause" });
    return out.map((a) => ({ detector: "pause", threat: "DoS.4", ...a }));
  },
  ttl(s, _monitor, { limits }) {
    return s.ttl
      .filter((t) => t.days === null || t.days < (t.kind === "code" ? limits.codeTtlDays : limits.ttlDays))
      .map((t) => ({
        detector: "ttl",
        threat: "DoS.2",
        level: t.days === null ? "critical" : "warning",
        message: t.days === null ? `${t.label} is archived or missing` : `${t.label} has ${t.days.toFixed(1)} days to live`,
        action: "extend",
        key: t.key,
        kind: t.kind,
        days: t.days,
      }));
  },
  exposure(s, _monitor, { limits }) {
    const out = [];
    const ratio = (a, b) => (BigInt(b) > 0n ? Number((BigInt(a) * 1000n) / BigInt(b)) / 1000 : 0);
    for (const f of s.funds) {
      const fundRatio = ratio(f.fundState.outstanding, f.config.max_outstanding);
      if (fundRatio >= limits.capWarnRatio) out.push({ level: "warning", message: `fund outstanding at ${(fundRatio * 100).toFixed(0)} % of its cap${tag(s, f)}`, action: "review limits" });
    }
    for (const [currency, c] of Object.entries(s.caps)) {
      const currencyRatio = ratio(c.outstanding, c.cap);
      if (currencyRatio >= limits.capWarnRatio) out.push({ level: "warning", message: `${currency} outstanding at ${(currencyRatio * 100).toFixed(0)} % of its cap`, action: "review limits" });
    }
    const hours = Math.max(((s.latest - s.from) * LEDGER_SECS) / 3600, 1 / 60);
    const opens = s.events.filter((e) => e.name === "repo_opened").length;
    if (opens / hours > limits.opensPerHour) out.push({ level: "warning", message: `${opens} repos opened in ${(hours * 60).toFixed(0)} min`, action: "pause if unexplained" });
    return out.map((a) => ({ detector: "exposure", threat: "DoS.1", ...a }));
  },
  fx(s, monitor, { limits }) {
    // Tamper.1, FX leg: a rate that keeps its value while its timestamp is
    // refreshed passes the age check. Track since when the published rate
    // has not moved; warn past a weekend. The band and the FX haircut bound
    // the loss meanwhile.
    const out = [];
    monitor.fxByFund ??= {};
    for (const f of s.funds) {
      if (!f.fx) continue;
      const price = String(f.fx.price);
      // The first fund's record predates the per-fund map: carry it over once.
      const seen = monitor.fxByFund[f.shares] ?? (f === s.funds[0] ? monitor.fx : undefined) ?? {};
      if (seen.price !== price) monitor.fxByFund[f.shares] = { price, since: Number(f.fx.timestamp), feedTimestamp: Number(f.fx.timestamp) };
      else monitor.fxByFund[f.shares] = { ...seen, feedTimestamp: Number(f.fx.timestamp) };
      if (f === s.funds[0]) monitor.fx = monitor.fxByFund[f.shares];
      const frozenHours = (s.now - monitor.fxByFund[f.shares].since) / 3600;
      const limit = monitor.fxFrozenHoursOverride ?? limits.fxFrozenHours;
      if (frozenHours < limit) continue;
      out.push({
        detector: "fx", threat: "Tamper.1", level: "warning",
        message: `FX rate unchanged for ${frozenHours.toFixed(1)} h while its timestamp is ${((s.now - Number(f.fx.timestamp)) / 60).toFixed(0)} min old: the age check cannot see a frozen market${tag(s, f)}`,
        action: "verify the market is closed; the FX band and haircut bound the exposure",
      });
    }
    return out;
  },
  keeper(s, monitor, { limits }) {
    // DoS.2: the keeper's float pays the rent extensions; an empty keeper means no extension.
    if (s.keeperXlm === null) return [{ detector: "keeper", threat: "DoS.2", level: "warning", message: `${s.keeperRole} account not readable`, action: "check the account" }];
    const min = monitor.keeperMinXlmOverride ?? limits.keeperMinXlm;
    if (s.keeperXlm >= min) return [];
    return [{ detector: "keeper", threat: "DoS.2", level: "warning", message: `${s.keeperRole} float ${s.keeperXlm.toFixed(1)} XLM is below ${min} XLM`, action: "top up the keeper from treasury" }];
  },
  events(s) {
    // Every repo opened inside the event window must have its repo_opened event (Repud.1).
    const seen = new Set(s.events.filter((e) => e.name === "repo_opened").map((e) => Number(e.topics[0])));
    const windowStart = s.now - (s.latest - s.from) * LEDGER_SECS;
    return s.repos
      .filter((r) => Number(r.opened_at) > windowStart + 60 && !seen.has(r.id))
      .map((r) => ({ detector: "events", threat: "Repud.1", level: "warning", message: `repo #${r.id} has no repo_opened event`, action: "investigate" }));
  },
  rpc(s, _monitor, { limits }) {
    // Infra.1: the monitor reads one RPC and trusts it. With several configured,
    // their heads are compared every pass: a silent endpoint, or two endpoints
    // more than `rpcLedgerGap` ledgers apart, mean one of them is lagging or
    // not on the same chain. The threat model's STRIDE table has no row for
    // the reading infrastructure; "Infra.1" names it until that row exists.
    if (!s.rpcHeights) return [];
    const out = s.rpcHeights
      .filter((h) => h.error)
      .map((h) => ({ level: "warning", message: `RPC ${h.url} did not answer getLatestLedger: ${h.error}`, action: "check the endpoint; the pass used another one" }));
    const answered = s.rpcHeights.filter((h) => !h.error);
    if (answered.length >= 2) {
      const top = answered.reduce((a, b) => (b.sequence > a.sequence ? b : a));
      const low = answered.reduce((a, b) => (b.sequence < a.sequence ? b : a));
      const gap = top.sequence - low.sequence;
      if (gap > limits.rpcLedgerGap) {
        out.push({ level: "warning", message: `RPC heads ${gap} ledgers apart: ${low.url} at ${low.sequence}, ${top.url} at ${top.sequence}`, action: "the lagging endpoint is stale or on another network; drop it from STELLAR_RPC_URLS if it persists" });
      }
    }
    return out.map((a) => ({ detector: "rpc", threat: "Infra.1", ...a }));
  },
  schema(s) {
    // Elev.2 / S29: code upgraded, migration not run. Entries answer SchemaOutdated
    // meanwhile; exits go on. Nothing is raised on code without the version.
    if (s.schemaVersion === null || s.schemaVersion >= EXPECTED_SCHEMA) return [];
    return [{ detector: "schema", threat: "Elev.2", level: "critical", message: `stored layout at version ${s.schemaVersion}, the code expects ${EXPECTED_SCHEMA}: migrate has not run since the upgrade`, action: "governor and trustee run migrate (npm run upgrade -- --apply)" }];
  },
  journal(s, _monitor, { journalPending }) {
    // Repud.2: every event the RPC served must be in the indexer's journal once
    // the journal covers its ledger. An event the journal does not cover yet
    // waits in `pending` and is checked on a later pass; one older than the
    // RPC's retention is dropped unchecked.
    if (!s.journal) return [];
    for (const e of s.events) {
      if (e.id) journalPending.set(`${e.txHash}:${e.id}`, { name: e.name, ledger: e.ledger, txHash: e.txHash });
    }
    const out = [];
    for (const [key, e] of journalPending) {
      if (s.journal.lastLedger === null || e.ledger > s.journal.lastLedger) {
        if (e.ledger < s.latest - 17_000) journalPending.delete(key);
        continue;
      }
      journalPending.delete(key);
      if (!s.journal.seen.has(key)) {
        out.push({ detector: "journal", threat: "Repud.2", level: "warning", message: `event ${e.name} at ledger ${e.ledger} missing from the indexer journal`, action: "run the indexer, then compare; a persistent gap means a tampered or stalled journal", tx: e.txHash });
      }
    }
    return out;
  },
};

/** Runs every detector on one snapshot. `ctx`: `{ limits, journalPending }`. */
export function detect(s, monitor, ctx) {
  const full = { limits: LIMITS, journalPending: new Map(), ...ctx };
  return Object.values(DETECTORS).flatMap((run) => run(s, monitor, full));
}

// ---------------------------------------------------------------------------
// The automatic actions (`--act`)
// ---------------------------------------------------------------------------

/** The proposals whose pending state the actions need: monitor.mjs reads only these before `decideActions`. */
export function factsNeeded(alerts, { keys = {} } = {}) {
  return {
    admin: alerts.some((a) => /veto_admin/.test(a.action ?? "")),
    forcedGuardian: Boolean(keys.trustee) && alerts.some((a) => a.action === "veto_forced"),
    upgrade: alerts.some((a) => a.action === "cancel"),
  };
}

/**
 * The safe automatic actions, in the order they are sent: vetoes, the
 * cancellation of an unannounced upgrade or stablecoin, the pause on a
 * critical alert, the TTL extensions, the reference refresh. `s.pending`
 * holds the proposals read for them (`factsNeeded`); `ctx.actor` is the key
 * that pauses and cancels, `ctx.keys` says which keys this host holds.
 * Returns `{ actions, alerts }`: `alerts` are raised instead of an action.
 */
export function decideActions(alerts, s, monitor = {}, { actor = "guardian", keys = {} } = {}) {
  const actions = [];
  const pending = s.pending ?? {};
  if (alerts.some((a) => /veto_admin/.test(a.action ?? ""))) {
    if (pending.admin && !(monitor.announcedAdmins ?? []).includes(pending.admin.admin)) {
      actions.push({ kind: "veto_admin", role: "guardian", admin: pending.admin.admin });
    }
  }
  if (keys.trustee && alerts.some((a) => a.action === "veto_forced")) {
    if (pending.forcedGuardian && !(monitor.announcedGuardians ?? []).includes(pending.forcedGuardian.guardian)) {
      actions.push({ kind: "veto_forced", role: "trustee", guardian: pending.forcedGuardian.guardian });
    }
  }
  if (alerts.some((a) => a.action === "cancel") && pending.upgrade) {
    actions.push({ kind: "cancel_upgrade", role: actor });
  }
  // rc4: a stablecoin proposed without an announcement is withdrawn the same way.
  for (const a of alerts.filter((x) => x.action === "cancel stablecoin" && x.token)) {
    actions.push({ kind: "cancel_stablecoin", role: actor, token: a.token });
  }
  if (!s.paused && alerts.some((a) => a.level === "critical" && a.action === "pause")) {
    actions.push({ kind: "pause", role: actor });
  }
  const extend = alerts.filter((a) => a.action === "extend" && a.key);
  const small = extend.filter((a) => a.kind !== "code").map((a) => a.key);
  if (small.length) actions.push({ kind: "extend", keys: small, ledgers: ENTRY_EXTEND_LEDGERS });
  // The code entry is large: extend it by 30 days at most per transaction, so
  // its rent stays well under the largest fee a transaction may carry.
  for (const a of extend.filter((x) => x.kind === "code")) {
    actions.push({ kind: "extend_code", key: a.key, targetDays: Math.min(Math.max(a.days ?? 0, 0) + CODE_STEP_DAYS, 120) });
  }
  // rc5: an old price reference is stepped along the model by the keeper.
  for (const a of alerts.filter((x) => x.action === "refresh_reference" && x.fund)) {
    actions.push({ kind: "refresh_reference", fund: a.fund });
  }
  return { actions, alerts: [] };
}
