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
  funds(s) {
    // oracle-3: one fund's failing read (a reverting feed, an RPC error) is
    // that fund's critical alert; the other funds and detectors keep running.
    // A fund the contract no longer lists was removed (`remove_fund`, governor,
    // immediate): its positions can still be repurchased and seized, and its
    // state and shares are still watched.
    const out = [];
    for (const f of s.funds) {
      if (f.removed) {
        const open = s.openRepos.filter((r) => String(r.fund) === f.shares).length;
        out.push({ level: "critical", threat: "Elev.2", message: `fund_removed: the contract no longer lists the fund (get_fund is None)${open ? `, ${open} repo(s) still open` : ""}${tag(s, f)}`, action: "verify the delisting with the governor; exits stay open; drop the fund from this deployment's state once intended", fund: f.shares });
      }
      const failed = Object.entries(f.errors ?? {});
      if (failed.length) {
        out.push({ level: "critical", threat: "DoS.10", message: `fund unreadable: ${failed.map(([what, why]) => `${what} failed (${why})`).join("; ")}${tag(s, f)}`, action: "check the feed and the endpoint; the other funds and detectors keep running", fund: f.shares });
      }
    }
    return out.map((a) => ({ detector: "funds", ...a }));
  },
  price(s, _monitor, { limits }) {
    const out = [];
    for (const f of s.funds) {
      if (!f.config) continue; // removed or unreadable: the funds detector reports it
      if (f.priceError) {
        // Open Window names its own codes bare; another contract's code is
        // `kind:Name` and a trap is HostError: inside `quote` both come from
        // the price feed, which the contract cannot read (oracle-3).
        const { name } = f.priceError;
        const fromFeed = name.includes(":") || name === "HostError";
        if (fromFeed || PRICE_REFUSALS.includes(name)) {
          out.push({ level: "critical", message: `the contract refuses the fund price: ${name}${fromFeed ? " (raised inside the valuation: the price feed fails)" : ""}${tag(s, f)}`, action: "pause", ground: { type: "price", fund: f.shares, stablecoin: f.stablecoin } });
        } else {
          out.push({ level: "critical", message: `the price probe is refused with ${name}, which is not a price refusal${tag(s, f)}`, action: "check the fund's settings and the stablecoin registry: the probe quotes in the fund's stablecoin" });
        }
      }
      if (f.nav === undefined) continue; // unread: the funds detector reports it
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
      if (!f.config || !f.fundState) continue;
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
  reconciliation(s, monitor) {
    // What the contract holds against what it owes. Only a deficit is
    // critical: shares or stablecoins missing mean a clawback, a freeze or a
    // fault, and new entries pause. A surplus is a transfer to the contract,
    // which no function can move out: anyone holding the asset can make one,
    // so it is a warning with its size and never a pause (econ-4).
    const out = [];
    // A surplus lasts (nothing moves it out): warned when it appears or
    // changes size, not every pass.
    monitor.surplusSeen ??= {};
    const surplus = (key, amount, alert) => {
      if (monitor.surplusSeen[key] === String(amount)) return;
      monitor.surplusSeen[key] = String(amount);
      out.push(alert);
    };
    const balanced = (key) => delete monitor.surplusSeen[key];
    // Invariant I2, per fund: shares held against the shares of open repos and of pending releases.
    for (const f of s.funds) {
      if (f.held === undefined || f.held === null) continue; // unread: the funds detector reports it
      const locked = s.openRepos.filter((r) => String(r.fund) === f.shares).reduce((sum, r) => sum + BigInt(r.shares), 0n);
      const awaiting = s.releases.filter((r) => String(r.fund) === f.shares).reduce((sum, r) => sum + BigInt(r.shares), 0n);
      const held = BigInt(f.held);
      const owed = locked + awaiting;
      const accounts = `contract holds ${units(held, 7, 7)} shares, open repos and releases account for ${units(owed, 7, 7)}`;
      if (held > owed) {
        surplus(`shares:${f.shares}`, held - owed, { threat: "DoS.5", level: "warning", message: `${accounts}: ${held - owed} units apart, a surplus no function can move out (I2 holds as an inequality)${tag(s, f)}`, action: "find who sent the shares; no pause: a surplus harms no position" });
        continue;
      }
      balanced(`shares:${f.shares}`);
      if (held < owed) {
        out.push({ threat: "DoS.5", level: "critical", message: `${accounts}: ${owed - held} units apart, shares missing (invariant I2)${tag(s, f)}`, action: "pause", fund: f.shares, ground: { type: "shares", fund: f.shares } });
      }
    }
    // Invariant I1, per stablecoin: the contract's balance against what the offers hold.
    for (const c of s.stablecoins ?? []) {
      if (c.error) {
        out.push({ threat: "DoS.8", level: "warning", message: `${c.label}: the contract's balance is unreadable (${c.error})`, action: "check the endpoint and the token" });
        continue;
      }
      if (c.held > c.owed) {
        surplus(`coin:${c.token}`, c.held - c.owed, { threat: "DoS.8", level: "warning", message: `${c.label}: the contract holds ${units(c.held - c.owed, 7, 7)} more than its offers, which no function can move out (I1 holds as an inequality)`, action: "find who sent it; no pause" });
        continue;
      }
      balanced(`coin:${c.token}`);
      if (c.held < c.owed) {
        out.push({ threat: "DoS.8", level: "critical", message: `${c.label}: the contract holds ${units(c.held, 7, 7)}, its offers ${units(c.owed, 7, 7)}: ${c.owed - c.held} units short (invariant I1)`, action: "pause", token: c.token, ground: { type: "coin", token: c.token } });
      }
    }
    // Deferred deliveries. A release that would return false is a waiting
    // position, not an error: one warning per position and reason, then
    // silence until its state changes. One that would deliver is the
    // keeper's to release (anyone may), and stays listed until it is.
    monitor.releaseSeen ??= {};
    const pending = new Set();
    for (const r of s.releases) {
      pending.add(String(r.id));
      const reason = r.deliverable === true ? "deliverable" : r.status === "Defaulted" && r.approved === false ? "unapproved" : "token";
      const seen = `${r.to}:${r.shares}:${reason}`;
      if (reason !== "deliverable" && monitor.releaseSeen[r.id] === seen) continue;
      monitor.releaseSeen[r.id] = seen;
      const f = s.funds.find((x) => x.shares === String(r.fund)) ?? { label: `fund ${String(r.fund).slice(0, 6)}` };
      const head = `repo #${r.id}: ${units(r.shares, 7, 0)} shares held back`;
      if (reason === "deliverable") {
        out.push({ threat: "DoS.5", level: "warning", message: `${head} can be delivered now to ${String(r.to).slice(0, 6)}…${tag(s, f)}`, action: "release", repoId: r.id });
      } else if (reason === "unapproved") {
        out.push({ threat: "DoS.7", level: "warning", message: `${head}, seized for a lender not approved for the fund: the delivery waits for its approval (rc5)${tag(s, f)}`, action: "the steward approves the lender again, or the lender redirects the release to an approved holder (redirect_release)" });
      } else {
        out.push({ threat: "DoS.5", level: "warning", message: `${head}, the share token refuses the transfer (issuer freeze or allowlist)${tag(s, f)}`, action: "contact the issuer; once the token accepts, anyone releases (the keeper with --act)" });
      }
    }
    for (const id of Object.keys(monitor.releaseSeen)) if (!pending.has(id)) delete monitor.releaseSeen[id];
    return out.map((a) => ({ detector: "reconciliation", ...a }));
  },
  stablecoins(s) {
    // DoS.8 (econ-6, state-4): an issuer that deauthorizes the contract's
    // balance makes every repurchase in that stablecoin fail while seizures
    // go ahead, so borrowers lose their collateral through no fault of
    // theirs. A pause would not help (new entries in that coin fail anyway):
    // people must act before the maturities.
    const out = [];
    for (const c of s.stablecoins ?? []) {
      if (c.authorized === false) {
        out.push({ level: "critical", message: `${c.label} has deauthorized the contract's balance: every repurchase in it fails while seizures go ahead`, action: `contact the issuer of ${c.label}; warn the borrowers of open repos in it before their maturity`, token: c.token });
      } else if (c.authError) {
        out.push({ level: "warning", message: `${c.label}: the contract's authorization is unreadable (${c.authError}); a token other than a Stellar Asset Contract may not answer it`, action: "check that token's own freeze by hand" });
      }
    }
    return out.map((a) => ({ detector: "stablecoins", threat: "DoS.8", ...a }));
  },
  lenders(s, monitor) {
    // DoS.7: a steward may revoke a lender's approval while its repos are
    // open. Since rc5 the seizure still settles to that lender, and the
    // shares then wait for its approval or a redirection. Warned when it
    // appears or the number of open repos changes, not every pass.
    const out = [];
    monitor.revokedSeen ??= {};
    const current = {};
    for (const l of s.lenders ?? []) {
      const f = s.funds.find((x) => x.shares === l.fund);
      if (l.approved !== false || !l.open || f?.removed) continue;
      const key = `${l.fund}:${l.lender}`;
      current[key] = l.open;
      if (monitor.revokedSeen[key] === l.open) continue;
      out.push({ level: "warning", message: `lender ${l.lender.slice(0, 6)}… is no longer approved on ${f?.label ?? l.fund.slice(0, 6)} while ${l.open} of its repo(s) are open: a seizure still settles, and the shares wait for its approval`, action: "ask the fund's steward why; after maturity the lender seizes, then is approved again or redirects the release (redirect_release)" });
    }
    monitor.revokedSeen = current;
    return out.map((a) => ({ detector: "lenders", threat: "DoS.7", ...a }));
  },
  privileged(s, monitor) {
    const out = s.events
      .filter((e) => PRIVILEGED.has(e.name))
      .map((e) => ({ level: "warning", message: `privileged change ${e.name} at ledger ${e.ledger}`, action: "verify", tx: e.txHash }));
    // A lost-steward recovery takes the fund from its issuer in 30 days: the issuer must know at once.
    for (const e of s.events.filter((ev) => ev.name === "steward_recovery_proposed")) {
      out.push({ level: "critical", message: `steward recovery proposed at ledger ${e.ledger}`, action: "tell the issuer; its steward key cancels it if the key is not lost", tx: e.txHash });
    }
    // A governor handover waits for the delay since version 4; the guardian
    // can veto it meanwhile. One announced beforehand (`--announce-admin=`)
    // is a warning and is never vetoed.
    for (const e of s.events.filter((ev) => ev.name === "admin_proposed" || ev.name === "admin_changed")) {
      const announced = e.name === "admin_proposed" && (monitor.announcedAdmins ?? []).includes(String(e.data?.proposed ?? ""));
      out.push({
        level: announced ? "warning" : "critical",
        message: `${e.name === "admin_proposed" ? "governor handover proposed" : "governor changed"} at ledger ${e.ledger}${announced ? " (announced)" : ""}`,
        action: announced ? "verify before it applies" : e.name === "admin_proposed" ? "verify with every signer; if unexpected, the guardian vetoes (veto_admin) inside the delay and keys are rotated" : "verify; if unexpected, treat as a key compromise",
        tx: e.txHash,
      });
    }
    for (const f of s.funds.filter((x) => x.stewardBackup === null)) {
      out.push({ level: "warning", message: `the fund's steward has no registered backup: a lost key could never be replaced${tag(s, f)}`, action: "ask the issuer to call set_steward_backup" });
    }
    // The one change the guardian cannot veto: 30 days to react, from now.
    // Announced beforehand (`--announce-guardian=`), the trustee does not veto it.
    for (const e of s.events.filter((ev) => ev.name === "guardian_change_forced")) {
      const announced = (monitor.announcedGuardians ?? []).includes(String(e.data?.guardian ?? ""));
      out.push({
        level: announced ? "warning" : "critical",
        message: `forced guardian change at ledger ${e.ledger}: the governor (with the trustee's consent, when one is named) replaces the guardian at ${e.data?.eta ? new Date(Number(e.data.eta) * 1000).toISOString().slice(0, 16) : "?"} UTC${announced ? " (announced)" : ""}`,
        action: announced ? "verify before it applies" : "veto_forced",
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
  proposals(s, monitor) {
    // Alert suppression (rpc-2): the proposals the automatic actions answer
    // are read from state on every pass, not only from their events. An
    // event an endpoint dropped, a pass that failed or an action that did
    // not land no longer hides one: unannounced, it stays critical, with its
    // action, until it is cancelled, vetoed or applied. The pass that reads
    // its event reports it there instead.
    const p = s.pending ?? {};
    const out = [];
    const at = (eta) => new Date(Number(eta) * 1000).toISOString().slice(0, 16);
    const reported = (name) => s.events.some((e) => e.name === name);
    if (p.upgrade && !(monitor.announced ?? []).includes(p.upgrade.hash) && !reported("upgrade_proposed")) {
      out.push({ level: "critical", message: `upgrade proposal pending, code ${p.upgrade.hash.slice(0, 12)} (NOT announced), applicable from ${at(p.upgrade.eta)} UTC`, action: "cancel" });
    }
    if (p.admin && !(monitor.announcedAdmins ?? []).includes(p.admin.admin) && !reported("admin_proposed")) {
      out.push({ level: "critical", message: `governor handover to ${p.admin.admin.slice(0, 8)}… pending (NOT announced), acceptable from ${at(p.admin.eta)} UTC`, action: "verify with every signer; if unexpected, the guardian vetoes (veto_admin) inside the delay" });
    }
    if (p.forcedGuardian && !(monitor.announcedGuardians ?? []).includes(p.forcedGuardian.guardian) && !reported("guardian_change_forced")) {
      out.push({ level: "critical", message: `forced guardian change to ${p.forcedGuardian.guardian.slice(0, 8)}… pending (NOT announced), applies at ${at(p.forcedGuardian.eta)} UTC`, action: "veto_forced" });
    }
    return out.map((a) => ({ detector: "proposals", threat: "Elev.2", ...a }));
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
      // A revoked approval is removed, not archived: the lenders detector reports it.
      .filter((t) => !(t.revoked && t.days === null))
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
      if (!f.config || !f.fundState) continue;
      const fundRatio = ratio(f.fundState.outstanding, f.config.max_outstanding);
      if (fundRatio >= limits.capWarnRatio) out.push({ level: "warning", message: `fund outstanding at ${(fundRatio * 100).toFixed(0)} % of its cap${tag(s, f)}`, action: "review limits" });
    }
    for (const [currency, c] of Object.entries(s.caps)) {
      if (c.error) {
        out.push({ level: "warning", message: `${currency} cap and outstanding unreadable: ${c.error}`, action: "check the endpoint" });
        continue;
      }
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
    //
    // Heights alone prove nothing about content (rpc-2): the pause flag and
    // the pending proposals the actions answer are also read on a second
    // endpoint, and any disagreement is critical. No automatic action rests
    // on a fact the endpoints do not agree on (monitor.mjs, act).
    const out = [];
    if (s.second?.error) {
      out.push({ level: "warning", message: `second endpoint ${s.second.url} unreadable: ${s.second.error}`, action: "no automatic action can be confirmed meanwhile; check the endpoint" });
    } else if (s.second) {
      for (const d of compareFacts(primaryFacts(s), s.second.facts)) {
        out.push({ level: "critical", message: `RPC endpoints disagree on ${d.fact}: ${s.primaryUrl ?? "the active endpoint"} reads ${d.primary}, ${s.second.url} reads ${d.second}`, action: "a lying, lagging or forked endpoint: nothing automatic rests on this; check both by hand" });
      }
    }
    if (!s.rpcHeights) return out.map((a) => ({ detector: "rpc", threat: "Infra.1", ...a }));
    out.push(...s.rpcHeights
      .filter((h) => h.error)
      .map((h) => ({ level: "warning", message: `RPC ${h.url} did not answer getLatestLedger: ${h.error}`, action: "check the endpoint; the pass used another one" })));
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

/**
 * The pause flag and the pending proposals as plain values, for comparing
 * two endpoints: a code hash, an address, or null when nothing is pending;
 * undefined when the read failed (not compared).
 */
export function proposalFacts({ paused, upgrade, admin, forcedGuardian } = {}) {
  const pick = (value, field) => (value === undefined ? undefined : value === null ? null : String(value[field]));
  return { paused, upgrade: pick(upgrade, "hash"), admin: pick(admin, "admin"), forcedGuardian: pick(forcedGuardian, "guardian") };
}

/** The facts of the snapshot's own (active) endpoint. */
export const primaryFacts = (s) => proposalFacts({ paused: s.paused, ...(s.pending ?? {}) });

/** The facts two endpoints read differently: `[{ fact, primary, second }]`. */
export function compareFacts(primary, second) {
  const names = { paused: "the pause", upgrade: "the pending upgrade", admin: "the pending governor handover", forcedGuardian: "the pending forced guardian change" };
  const show = (value) => (value === null ? "nothing" : String(value));
  return Object.keys(names)
    .filter((fact) => primary?.[fact] !== undefined && second?.[fact] !== undefined && primary[fact] !== second[fact])
    .map((fact) => ({ fact: names[fact], primary: show(primary[fact]), second: show(second[fact]) }));
}

/**
 * Records an announcement flag in the monitoring state, so that `--act`
 * reports the planned change instead of answering it: an upgrade
 * (`--announce=<wasm hash>`), a stablecoin registration
 * (`--announce-stablecoin=<C...>`), a governor handover
 * (`--announce-admin=<address>`) or a forced guardian change
 * (`--announce-guardian=<address>`). Before the last two existed, nothing
 * wrote their lists and `--act` vetoed every handover, planned or not.
 * Returns the line to print, or null without such a flag; throws on an
 * address `isAddress` refuses.
 */
export function recordAnnouncement(monitor, args, { isAddress = () => true } = {}) {
  const flags = [
    ["--announce=", "announced", "Upgrade", (value) => value.toLowerCase(), () => true],
    ["--announce-stablecoin=", "announcedStablecoins", "Stablecoin", (value) => value, () => true],
    ["--announce-admin=", "announcedAdmins", "Governor handover to", (value) => value, isAddress],
    ["--announce-guardian=", "announcedGuardians", "Forced guardian change to", (value) => value, isAddress],
  ];
  for (const [flag, field, what, normalize, valid] of flags) {
    const raw = args.find((a) => a.startsWith(flag))?.slice(flag.length);
    if (!raw) continue;
    if (!valid(raw)) throw new Error(`${flag} takes a G... or C... address, not ${raw}`);
    const value = normalize(raw);
    monitor[field] = [...new Set([...(monitor[field] ?? []), value])];
    return `${what} ${value} recorded as announced.`;
  }
  return null;
}

/**
 * The safe automatic actions, in the order they are sent: the cancellation
 * of an unannounced upgrade or stablecoin and the pause first, as the
 * sentinel needs no other key; then the vetoes; then the keeper's
 * extensions, reference refresh and releases. `s.pending` holds the
 * proposals the snapshot read; `ctx.actor` is the key that pauses and
 * cancels, `ctx.keys` the keys this host holds, `ctx.limits` the thresholds.
 * Returns `{ actions, alerts }`: `alerts` stand where a key is missing.
 */
export function decideActions(alerts, s, monitor = {}, { actor = "guardian", keys = {}, limits = LIMITS } = {}) {
  const actions = [];
  const raised = [];
  const pending = s.pending ?? {};
  const asked = (test) => alerts.some(test);
  if (asked((a) => a.action === "cancel") && pending.upgrade && !(monitor.announced ?? []).includes(pending.upgrade.hash)) {
    actions.push({ kind: "cancel_upgrade", role: actor, hash: pending.upgrade.hash });
  }
  // rc4: a stablecoin proposed without an announcement is withdrawn the same way.
  for (const token of new Set(alerts.filter((x) => x.action === "cancel stablecoin" && x.token).map((x) => x.token))) {
    actions.push({ kind: "cancel_stablecoin", role: actor, token });
  }
  const pauses = alerts.filter((a) => a.level === "critical" && a.action === "pause");
  if (!s.paused && pauses.length) actions.push({ kind: "pause", role: actor, grounds: pauses.map((a) => a.ground).filter(Boolean) });
  // A veto needs its key on this host (auth-6): without it, a critical alert
  // asks a human to veto inside the delay; the other actions go on.
  if (asked((a) => /veto_admin/.test(a.action ?? "")) && pending.admin && !(monitor.announcedAdmins ?? []).includes(pending.admin.admin)) {
    if (keys.guardian) actions.push({ kind: "veto_admin", role: "guardian", admin: pending.admin.admin });
    else raised.push({ detector: "act", threat: "Elev.2", level: "critical", message: `governor handover to ${pending.admin.admin} pending and not announced; this host holds no guardian key`, action: "the guardian vetoes by hand (veto_admin) inside the delay; a planned handover is announced with --announce-admin=" });
  }
  if (asked((a) => a.action === "veto_forced") && pending.forcedGuardian && !(monitor.announcedGuardians ?? []).includes(pending.forcedGuardian.guardian)) {
    if (keys.trustee) actions.push({ kind: "veto_forced", role: "trustee", guardian: pending.forcedGuardian.guardian });
    else raised.push({ detector: "act", threat: "Elev.2", level: "critical", message: `forced guardian change to ${pending.forcedGuardian.guardian} pending and not announced; this host holds no trustee key`, action: "the trustee vetoes by hand (veto_forced_guardian_change) inside the 30 days; a planned change is announced with --announce-guardian=" });
  }
  const extend = alerts.filter((a) => a.action === "extend" && a.key);
  const small = extend.filter((a) => a.kind !== "code").map((a) => a.key);
  if (small.length) actions.push({ kind: "extend", keys: small, ledgers: ENTRY_EXTEND_LEDGERS, belowDays: limits.ttlDays });
  // The code entry is large: extend it by 30 days at most per transaction, so
  // its rent stays well under the largest fee a transaction may carry.
  for (const a of extend.filter((x) => x.kind === "code")) {
    actions.push({ kind: "extend_code", key: a.key, targetDays: Math.min(Math.max(a.days ?? 0, 0) + CODE_STEP_DAYS, 120), belowDays: limits.codeTtlDays });
  }
  // rc5: an old price reference is stepped along the model by the keeper.
  for (const a of alerts.filter((x) => x.action === "refresh_reference" && x.fund)) {
    actions.push({ kind: "refresh_reference", fund: a.fund });
  }
  // A deferred delivery the simulated release says would go through: the
  // keeper sends it (anyone may). A waiting one is never retried blindly.
  for (const a of alerts.filter((x) => x.action === "release" && x.repoId !== undefined)) {
    actions.push({ kind: "release", repoId: a.repoId });
  }
  return { actions, alerts: raised };
}

/** Whether one ground of a pause holds in a second reading. */
function groundHolds(ground) {
  if (!ground) return false;
  if (ground.type === "price") return Boolean(ground.refusal);
  return ground.held !== undefined && ground.owed !== undefined && BigInt(ground.held) < BigInt(ground.owed);
}

/**
 * Whether what a second endpoint read (`seen`, the facts monitor.mjs reads
 * for each kind of action) supports the action the first endpoint's facts
 * decided (rpc-2): `{ agree, detail, action }`. Anything the second reading
 * lacks counts as no. An extension keeps only the entries the second
 * endpoint also finds short-lived.
 */
export function confirmation(action, seen) {
  const no = (detail) => ({ agree: false, detail, action });
  const yes = (narrowed = action) => ({ agree: true, detail: "", action: narrowed });
  switch (action.kind) {
    case "cancel_upgrade":
      return hex(seen.pendingUpgrade?.wasm_hash) === action.hash ? yes() : no(`its pending upgrade is ${seen.pendingUpgrade ? hex(seen.pendingUpgrade.wasm_hash).slice(0, 12) : "none"}`);
    case "cancel_stablecoin":
      return seen.pendingStablecoin ? yes() : no("no such stablecoin proposal is pending there");
    case "veto_admin":
      return seen.pendingAdmin && String(seen.pendingAdmin.admin) === action.admin ? yes() : no(`its pending handover is ${seen.pendingAdmin ? String(seen.pendingAdmin.admin) : "none"}`);
    case "veto_forced":
      return seen.pendingForcedGuardian && String(seen.pendingForcedGuardian.guardian) === action.guardian ? yes() : no(`its pending forced change is ${seen.pendingForcedGuardian ? String(seen.pendingForcedGuardian.guardian) : "none"}`);
    case "pause":
      return (seen.grounds ?? []).some(groundHolds) ? yes() : no("neither the price refusal nor the deficit is read there");
    case "extend":
    case "extend_code": {
      const keys = action.kind === "extend" ? action.keys : [action.key];
      const short = keys.filter((_, i) => seen.ttlDays?.[i] === null || seen.ttlDays?.[i] < action.belowDays);
      if (!short.length) return no(`every entry has ${action.belowDays} days or more to live there`);
      return yes(action.kind === "extend" ? { ...action, keys: short } : action);
    }
    case "refresh_reference":
      return seen.now - seen.referenceTime > seen.navMaxAge ? yes() : no("the reference is within its NAV age bound there");
    case "release":
      return seen.release === true ? yes() : no("the release would not deliver there");
    default:
      return no(`no second reading for ${action.kind}`);
  }
}
