# Interface reference

The long-form description of every entry point, type and error of the Open Window contract (`contracts/night-window/src/`). The doc comments in the source are kept to one sentence each, because `#[contractimpl]`, `#[contracttype]`, `#[contracterror]` and `#[contractevent]` compile them into the `contractspecv0` section of the WASM, which counts against the network's size cap; this file holds the explanations that used to sit there. Who may call what and the one-line summary of each function are in the [README](../README.md#contract-interface); the decisions referred to as S7, S8, S9 and the custody gaps I12 to I14 are in [securite.md](securite.md).

Conventions used below:

- *Delay* is the instance's time delay (`timelock_delay`), 48 hours by default. *Longest delay* is the thirty-day maximum (`MAX_TIMELOCK_SECS`).
- *Due* means the proposal's `eta` has passed and its grace period (seven days, `PROPOSAL_GRACE_SECS`) has not: a forgotten proposal must not be applied months later, against a situation its signers never saw. Every `pending_*` getter returns nothing once a proposal has expired.
- *Steward on record* is the fund's current steward or, after a removal, the last installed one (`LastSteward`), who keeps the issuer's say over a re-admission.
- Functions whose signature returns nothing (`set_admin`, `upgrade`, `set_guardian`, `hand_over_guardian`, `force_guardian_change`, `set_stablecoin`, `unpause`, `set_guardian_backup`) keep the version 2 shape; their failures are raised as typed contract errors rather than returned.

## Governor

### `set_admin(new_admin)`

Proposes `new_admin` as governor. Nothing changes until the proposed address accepts (decision S7: a typo cannot lose the role). Before the first admission it may accept at once. Afterwards it may accept only once the delay has elapsed, within the grace period, and the guardian can veto the handover meanwhile (custody gap I12): a stolen governor quorum can no longer take the role inside one window. Replaces an earlier proposal.

### `accept_admin()`

Completes a governor handover, from its eta to the end of its grace period. Requires the proposed address. The proposals the previous governor made alone (upgrade, guardian, term ceiling, envelope, currency caps) are dropped: a handover is often the answer to a compromised key, and the new governor re-proposes what it wants. Fund replacements, fallbacks and fund limits carry a steward's signature and stay.

### `cancel_admin()`, `veto_admin(caller)`

`cancel_admin` withdraws a handover proposed by `set_admin`, for instance one proposed to a wrong or compromised address. `veto_admin` is the guardian's answer to a governor quorum that proposes a successor it should not; `caller` must be the guardian, the governor or the trustee.

### `pending_admin()`

The proposed governor and when it may accept, unless the proposal has expired. One proposed before version 4 (a `PendingAdmin` entry left by an upgrade) was proposed without the delay; it is never honoured, shows as expired (eta 0) and can only be cleared by a cancellation, a veto or a new proposal.

### `set_timelock_delay(delay)`

Between one minute and thirty days. Until a fund is first admitted nothing is at stake, so any value in that range is accepted (a demonstration may run with minutes); from then on the delay may only grow, or a compromised governor would shorten the window before acting. Proposals already made keep their eta.

## Upgrades

### `propose_upgrade(wasm_hash)`, `upgrade(new_wasm_hash)`, `cancel_upgrade(caller)`

The proposal names the new code, applicable by `upgrade` once the delay has elapsed; it replaces any earlier proposal and needs the trustee's signature when one is named. `upgrade` replaces the contract code with the proposed WASM, which must already be uploaded; storage and address are kept, and the `Upgraded` event is published just before the switch, by the code being replaced. `cancel_upgrade` takes the governor, the guardian or the trustee as `caller`: their veto is what the delay is for.

## Term ceiling, envelope, currency caps

The three follow the same pattern (decision S7): a change that only tightens applies at once and drops a pending loosening; after the first admission, a loosening waits for the delay and applies through the matching `apply_*` function, which anyone may call; the governor or the guardian may cancel it meanwhile.

### `set_max_term(max_term)`

Sets the ceiling for a repo term, in seconds. A decrease applies at once. An increase lengthens the exposure of every offer, so after the first admission it waits for the delay and applies through `apply_max_term_change`.

### `set_envelope(envelope)`

Applies to fund settings made afterwards. An envelope that only tightens (every minimum at least the current one, every maximum at most the current one) applies at once. Any loosening waits for the delay and applies through `apply_envelope_change`. Every bound must be a valid quantity.

### `set_currency_cap(currency, cap)`

Caps open principals in a currency. Unset means zero: no lending until the governor sets it. A decrease applies at once. An increase raises the exposure of every lender in that currency, so it waits for the delay and applies through `apply_currency_cap_change(currency)`. At most `MAX_PENDING_CURRENCY_CAPS` currencies may have a pending increase at the same time; they share one instance entry.

## Guardian

### `set_guardian(guardian)`

Before the first admission it applies at once. Afterwards it waits for the delay and applies through `apply_guardian_change`, and the current guardian can cancel it: a governor key alone cannot remove the veto inside the window in which that veto is needed (decision S7).

### `apply_guardian_change()`

Appoints the proposed guardian once due. A forced change still waiting is dropped: the guardian it meant to replace is gone, and the ordinary path, which that guardian could veto, has settled the question. Any path that installs a guardian also drops the guardian backup: it was agreed with the guardian leaving office, and after a forced change that guardian may be the hostile one.

### `set_guardian_backup(backup)`, `guardian_backup()`

Registers, at once, the only address the guardian may hand its role over to. Requires both the governor and the current guardian: either key alone cannot choose where the veto goes. Replaces an earlier backup.

### `hand_over_guardian(guardian)`

Passes the guardian role at once. Requires the current guardian, and `guardian` must be the registered backup (custody gap I13): a stolen hot guardian key can no longer hand the role to its thief, and a rotation to the prepared backup still never waits. The backup is consumed. Without a backup the handover is allowed only while the guardian is the governor, whose key gains nothing by it.

### `force_guardian_change(guardian)`

Imposes a guardian without the current one, for a guardian key that is lost or hostile and cancels every ordinary change. It waits for the longest delay, thirty days in public, and only the governor can cancel it (`cancel_forced_guardian_change`): the guardian it replaces has no veto here, or a lost key would freeze governance forever. Replaces an earlier forced change. Requires the governor and the trustee when one is named; the trustee may also veto it (`veto_forced_guardian_change`). `apply_forced_guardian_change` installs it once due; anyone may call it.

## Trustee

### `set_trustee(trustee)`

Names the trustee, whose signature every upgrade and forced guardian change then needs, and who may cancel them and veto a governor handover. Once, before the first admission and the first offer. Requires the governor and the trustee. Proposals made without the trustee go. The trustee consents independently: it holds no governance role and is not the sole lender, and the independence holds in both directions: no role, backup or governor handover may later name the trustee.

### `hand_over_trustee(trustee)`

Passes the trustee role at once. Requires the current trustee and `trustee`: no other key names or removes a trustee. A pending upgrade or forced guardian change is dropped, since the previous trustee co-signed it.

## Stablecoins and the sole lender

### `set_stablecoin(stablecoin, currency)`, `remove_stablecoin(stablecoin)`

Registers a stablecoin for a currency; its decimals are read from the token. A removal lets open repos and offers keep working for exits.

### `set_sole_lender(lender)`

Makes this a single-lender instance (bilateral mode): from now on only `lender` may create offers, which anyone, supervisors included, can check on chain. Allowed once, before the first admission and the first offer, so that no lender already in place is shut out and the mode cannot be switched on or off under existing offers.

## Funds

### `set_fund(fund, config)`

Admits a fund, or proposes a replacement of its configuration. Requires both the governor and the fund's steward: a two-key admission. A replacement also requires the current steward, and cannot change the currency while repos are open. Checks the configuration against the envelope, checks the oracles report in the right currency, reads the decimals and fresh prices.

A first admission applies at once: no offer can list the fund yet, so nobody is exposed to it, and the NAV and FX references are anchored on the fresh readings. A replacement changes the oracle or the haircut under existing offers, so it is stored and applies through `apply_fund_change` once the delay has elapsed (decision S7). A fund that was removed keeps its runtime state, so its re-admission is a replacement too: removing then re-admitting cannot skip the delay, nor the issuer: the steward on record must sign when the new configuration names another. A replacement keeps the NAV and FX references unless it changes the feed, and then the new feed must agree with them (the new reading must lie in the corridor around the current reference, or within the band around the current FX reference); the only way to move them otherwise is `propose_reanchor`. A replacement that gives the fund its first FX leg anchors it on the rate read now (`PendingFundChange.fx_anchor`). For a removed fund, the agreement with the references is checked at the apply only, so that a re-anchor proposed meanwhile can bring them to the new feed. Open repos keep their frozen terms (invariant I9).

### `apply_fund_change(fund)`

Applies a due replacement. Anyone may call it: the keys signed the proposal. The configuration is checked again now, with fresh prices. The references carry over from the current state, so the caller's choice of moment cannot re-anchor them on a spot price; a new feed must agree with them, and a first FX leg takes the rate read at the proposal. On failure the proposal stays for a later attempt. Installing a configuration drops the proposals made against the one it replaces: pending loosened limits and a pending re-anchor (both read against the old settings), and a pending fallback when the steward who signed it is no longer the steward.

### `cancel_fund_change(fund, caller)`

`caller` must be the governor, the guardian or the fund's current steward.

### `remove_fund(fund)`

Removes a fund from the registry, at once: removal never harms an open repo. Open repos on that fund can still be repurchased or seized: their terms are frozen, and their principal is still released from the fund and currency totals when they close. A pending replacement and the fallback feed go with it, so that nothing brings the fund back on its own. The steward is recorded first: a fund admitted before that record existed, or whose record aged, still cannot be re-admitted without its issuer.

## Steward backup and recovery

### `set_steward_backup(fund, backup)`

Names the successor a steward recovery may install for this fund. Requires the fund's steward on record alone: the key holder names its own successor, so the governor and the guardian can never pick the issuer's replacement (the governor can cancel a replacement, so it can block one, never choose one). The backup signs too, proving its key exists. It must not be a lender approved on the fund. A first backup is set at once; replacing one waits for the delay and applies through `apply_steward_backup_change`, the current backup staying valid until then. `cancel_steward_backup_change` takes the steward on record or the governor as `caller`. A steward change drops a pending replacement.

### `propose_steward_recovery(fund)`

Proposes to install the steward's registered backup for a fund whose steward key is lost (custody gap I14): without this path, a lost bare key would keep the fund out for good. It takes the governor and the guardian, two distinct keys, and waits for the longest delay, thirty days. Any action the steward signs on the fund meanwhile proves its key alive and cancels it; the steward on record or the governor can also cancel it (`cancel_steward_recovery`; the guardian alone cannot, since a recovery needed its signature and its veto would be a second vote). It dies if the steward or a governance role changes before it applies (the proposal records the steward and the governance generation of the moment). A pending backup replacement, signed by a key that may be the lost one, goes. Works for a removed fund too. Replaces an earlier proposal.

### `apply_steward_recovery(fund)`

Installs the steward's backup once the thirty days have elapsed, within the grace period; the backup signs, accepting the role. Proposals the previous steward signed go. Returns `false`, removing the proposal, when it can no longer apply (expired, steward or governance changed); anyone may then call it. `pending_steward_recovery` returns the proposal only while it can still apply.

## Re-anchoring

### `propose_reanchor(fund, expected_nav, expected_fx)`

Proposes to re-anchor a fund's NAV and FX references, the only way to move them other than along the model path or down by the steward: after a legitimate jump, or to re-admit a removed fund whose new feed no longer lies on the old path. The fresh readings of the feed are taken now and stored; they are what the apply installs, so whoever applies cannot choose the anchor. The feed is the fund's current one, or for a removed fund the one of its pending re-admission, and the NAV is read under the pricing rule: the primary feed must be fresh, and a fresh fallback must agree with it.

The signers sign numbers, not just a moment: `expected_nav` and `expected_fx` (0 for a fund priced directly) are the values they agreed on, and the readings must lie within the fund's corridor floor (NAV) and the leg's band (FX) of them, or the proposal is refused. Replaces an earlier proposal. Requires the governor and the fund's steward on record.

### `apply_reanchor(fund)`

Installs a due re-anchor. Anyone may call it. The fund must still be priced by the feeds the proposal read, and they must still agree with it: today's NAV within the corridor that starts at the proposed NAV (the model path, so a fund that accrued during the delay still passes), today's FX rate within the leg's band of the proposed rate. The references become the proposed readings, not today's. `cancel_reanchor` takes the governor, the guardian or the steward on record as `caller`.

## Fallback NAV feed

### `propose_fallback(fund, feed)`

It is an oracle change, so it needs the same two keys as an admission and waits for the delay. The feed must report in the NAV oracle's base, publish a fresh price for the shares now and agree with the primary feed when that one is fresh. Its age limit stays within the envelope's NAV age and the fund's own limit for its primary feed: a backup older than the primary would be allowed to be is no backup. Its divergence tolerance stays within the envelope's corridor floor: the floor is how far below the model the protocol lets a NAV fall before it calls the price faulty, so two feeds of the same NAV that differ by more than that cannot both be right. Replaces any earlier proposal. At most `MAX_FALLBACKS` funds may have one: each keeps its decimals in instance storage, which every invocation loads, so that a fund without fallback reads no extra ledger entry when it is valued.

### `apply_fallback(fund)`, `cancel_fallback(fund, caller)`

The apply checks the feed again before activating it; anyone may call it. `caller` of the cancellation must be the governor, the guardian or the fund's steward.

### `remove_fallback(fund, caller)`

Removes a fund's fallback feed at once: removing a source never loosens a check. It does stop valuation when the primary feed stops, so it takes more than one ordinary key: the guardian alone (the role that acts in emergencies), or the governor and the fund's steward together, `caller` being either of them; the other one must sign too.

## Pause

### `pause(caller)`, `unpause()`

The pause suspends new offers and new repos; `caller` must be the guardian or the governor. Exits (repurchase, withdrawal of an offer, seizure, release) stay open. Only the governor lifts it.

## Steward operations

### `set_fund_limits(fund, haircut_bps, max_principal_per_repo, max_outstanding)`

Tunes a fund's haircut and caps inside the envelope. A change that only tightens (haircut not lower, caps not higher) applies at once and drops a pending loosening. Any loosening exposes the fund's lenders more on one key, so it waits for the delay and applies through `apply_fund_limits_change`, which checks it against the envelope again; the governor, the guardian or the steward can cancel it meanwhile (decision S7). Open repos keep their frozen terms.

### `approve_lender(fund, lender, approved)`

Approves or revokes a lender for a fund, from the issuer's own list of authorized holders: seized shares can then always reach the lender (decision S8). An approval needs the lender's attestation for the fund, co-signed by the current steward, and the steward can never approve itself: the issuer does not lend against its own fund (MMF Regulation, Art. 35). The steward on record is refused as well. A revocation also removes the attestation, so a return needs a fresh one; the events keep the trail.

### `attest_lender(fund, lender, declaration)`

Records that `lender` and the fund's steward both signed the declaration whose hash is `declaration` (eligibility, no group or economic link with the fund's manager, agreement reference): the trail counsel and auditors follow from an on-chain address to a signed document. The document stays off-chain; no personal data goes on chain. Replaces an earlier attestation of the pair. Requires the lender and the fund's steward, who may not be the same address.

### `freeze_fund(fund, frozen)`

Suspends or resumes new repos on a fund. Exits stay open.

### `reset_reference(fund)`

Lowers the NAV reference to the oracle's current NAV, for instance after a legitimate drop. It can only lower it: upward, the reference follows the model path, so a steward who also runs the feed cannot inflate the collateral. Takes no price from the caller; the NAV follows the same rule as a valuation, so a fresh fallback stands in for a silent primary feed.

### `set_sponsor(offer_id, fund, sponsor)`

Marks an offer as designated by the fund's issuer. A label only: an independent lender funds it, with no privilege. The offer must accept the fund.

## Open to anyone

### `refresh_reference(fund)`

Moves a fund's NAV reference forward when the oracle's NAV is fresh, newer and inside the corridor. The reference never falls and rises at most along the model path. Anyone may call it, like feeding a watchdog: it cannot be made to follow a faulty feed.

### `fund_price(fund)`, `quote(fund, shares, stablecoin)`, `repo_due(repo_id)`

`fund_price` is the last NAV reported by the fund's oracle, unchecked. `quote` is what `shares` of `fund` can secure now in `stablecoin`, with every check `open_repo` applies to the price. `repo_due` is the interest due on a repo if it were repurchased now.

## Lending

### `create_offer(lender, stablecoin, amount, rate_bps, max_term, funds)`

The lender deposits `amount` of `stablecoin` with their terms. The lender must be approved by the current steward of every fund listed (an approval implies the attestation that steward co-signed), must not be the steward of any of them, and in a single-lender instance must be the sole lender. The fund list must name one to `MAX_FUNDS_PER_OFFER` distinct funds. Returns the offer identifier.

### `withdraw_offer(offer_id, amount)`

The lender takes back `amount` of the stablecoins not lent, including repaid principal and interest. Works while paused.

### `open_repo(borrower, offer_id, fund, shares, principal, term)`

The borrower locks `shares` of `fund` against `offer_id` and receives `principal` stablecoins in the same transaction, for `term` seconds. The contract refuses rather than adjusts: the borrower states what they want. Returns the repo identifier.

### `repurchase(repo_id)`

The borrower repays principal and interest and gets the shares back. Allowed before and after maturity until the repo is seized, and while paused. Interest runs at the repo rate until repayment, per started hour, with a minimum of one hour. Principal and interest both flow back into the offer, where the lender withdraws them: nothing in the borrower's exit depends on an address the lender controls.

If the share token refuses to return the shares (issuer freeze, allowlist removal, clawback), the debt still settles and the repo closes; the shares stay attributed to the borrower as a pending release that anyone can retry with `release` (decision S9). A failed repayment still reverts everything.

### `seize(repo_id, to)`

From maturity, the lender seizes the shares of an unpaid repo and sends them to `to`, the lender or another address the fund's steward approved. Allowed while paused. If the share token refuses the delivery, the repo still defaults and the shares wait for `to` as a pending release (decision S9).

### `release(repo_id)`

Retries the delivery of shares a closed repo owes, to the beneficiary recorded. Anyone may call it, typically once the issuer has lifted the freeze or restored the allowlist; only the beneficiary can change itself (`redirect_release`), and no other path moves these shares. Works while paused. Returns whether the shares were delivered. A refusal is not an error: the call succeeds so that the record's TTL extension is kept, and the record waits for the next attempt.

### `redirect_release(repo_id, to)`

Changes where the shares awaiting release go, for instance when the issuer will never let the recorded address hold them again. After a repurchase the shares are the borrower's, so the borrower signs and picks any address; after a seizure they are the lender's, so the lender signs and picks another address the fund's steward approved (decision S8). Delivery still goes through `release`.

## Types

Storage keys (`DataKey`) are not part of the interface; their doc comments stay in `types.rs`.

- **`PriceData`**: a price point as defined by SEP-40. `price` carries the oracle's `decimals()` fractional digits; `timestamp` is a Unix timestamp.
- **`RiskEnvelope`**: limits that no fund configuration may exceed, set by the governor. Stewards tune their fund inside it, the way a calibration stays inside the limits a manufacturer burns into the firmware. `max_fx_band_bps` is the widest band an FX rate may move from its reference.
- **`FxLeg`**: second leg of a cross price: the fund's NAV oracle reports in one base (for instance USD) and the loan is in another currency (for instance EUR). The FX oracle must report `asset` (the loan currency as quoted by the FX oracle, e.g. `Other(EUR)`) in the same base as the NAV oracle. `haircut_bps` is an extra haircut covering a weekend gap of the exchange rate. `band_bps` is the band around the reference rate, both ways; the reference is set at admission, which needs both the governor and the steward. The band may not exceed the FX haircut: a rate the band admits must stay covered by the haircut.
- **`PriceSource`**: `Direct` when the NAV oracle reports in the loan currency; `Cross(FxLeg)` when it reports in another base and the leg converts it.
- **`FundConfig`**: `oracle` is the SEP-40 oracle publishing the fund's NAV and `oracle_asset` the identifier of the shares in it; `haircut_bps` the haircut on the share value; `steward` the issuer's key, which approves lenders and tunes the fund in the envelope; `currency` the currency of the stablecoins this fund can be borrowed against; `source` direct, or crossed through an FX feed when the NAV oracle does not report in `currency`; `nav_max_age_secs` the oldest acceptable NAV; `corridor_floor_bps` the lower margin of the NAV corridor; `max_yield_bps` the highest annual growth the corridor allows; `max_principal_per_repo` the cap on the principal of one repo, in stablecoin units; `max_outstanding` the cap on the sum of open principals on this fund.
- **`FundState`**: runtime state, kept apart from the configuration. `currency` is copied from the configuration so that totals can be released even after the fund or its stablecoin leaves the registry; `share_decimals` and `nav_decimals` are read at admission; `fx_decimals` is 0 without FX leg; `reference_nav` and `reference_time` are the reference NAV of the corridor and its timestamp; `reference_fx` the reference FX rate, 0 without FX leg; `outstanding` the sum of open principals; `frozen` is set by the steward to suspend new repos.
- **`StablecoinConfig`**: `decimals` is read from the token when registered.
- **`Offer`**: a lender's standing offer. Borrowers take it in one transaction; the principal repaid flows back into it. `available` is the amount available to borrow now; `rate_bps` the annual rate; `max_term` the longest term the lender accepts, in seconds; `funds` the fund shares accepted as collateral; `sponsor` is marked by a fund's steward for the issuer's own designated offer.
- **`Repo`**: shares locked against a stablecoin loan; its terms are frozen at opening (invariant I9). `opened_at` is the ledger timestamp at opening; `maturity` the ledger timestamp from which the lender may seize the shares.
- **`Quote`**: read-only, for interfaces. `price` is the share price in the loan currency, with `price_decimals` digits; `haircut_bps` the fund haircut plus the FX haircut when the price is crossed.
- **`PendingUpgrade`**: an upgrade proposed by the governor (decision S7), applicable by the governor from `eta` on, or cancelled by the governor, the guardian or the trustee until then.
- **`PendingFundChange`**: a replacement of an admitted fund's configuration, signed by the governor and the steward(s), waiting for its delay. `fx_anchor` is set when the replacement gives the fund its first FX leg: the rate read at the proposal, which becomes the FX reference; the rate at the apply must lie within the leg's band of it, so whoever applies does not pick the anchor. Zero otherwise. Anyone may apply it from `eta`.
- **`PendingReanchor`**: a re-anchoring of a fund's references, signed by the governor and the steward. The references it installs are the readings taken at the proposal, never the spot at the apply. `nav_oracle` and `nav_asset` are the feed the readings come from; the apply requires the fund to be priced by the same one. `nav` is the NAV read at the proposal, with `nav_decimals` digits, and `nav_time` its time. `fx` is the FX rate read at the proposal, for a cross price.
- **`AnchorFx`**: the FX side of a re-anchor: `Direct` for a fund priced directly, or `Cross(AnchorRate)` for a cross price. An enum, like `PriceSource`, rather than a zero rate with zero decimals that could pass for a reading. **`AnchorRate`** is the rate with `decimals` digits and the feed (`oracle`, `asset`) it comes from.
- **`PendingRelease`**: shares a closed repo owes but the share token refused to deliver: the issuer froze the contract or the recipient, removed one of them from its allowlist, or clawed shares back (decision S9). `to` is the borrower after a repurchase, the seizure recipient after a default. Anyone may retry the delivery to `to`; nothing else moves these shares.
- **`FallbackFeed`**: a second NAV source, used when the primary feed is stale or silent and checked against it when both are fresh. `oracle` is a SEP-40 oracle reporting in the same base as the fund's NAV oracle; `asset` the identifier of the shares in it; `max_age_secs` the oldest acceptable price, within the envelope's NAV age; `max_divergence_bps` the largest gap allowed between the two feeds when both are fresh, in basis points of the primary NAV.
- **`PendingGuardianChange`**: a guardian appointment waiting for its delay. The current guardian can cancel it, so a governor key alone cannot remove the veto in time. Also the shape of a forced change.
- **`PendingMaxTermChange`**, **`PendingEnvelopeChange`**, **`PendingFundLimitsChange`**, **`PendingCurrencyCapChange`**, **`PendingFallback`**: a loosening waiting for its delay; anyone may apply it from `eta`. An envelope change loosens at least one bound; a fund limits change is a lower haircut or higher caps proposed by the steward.
- **`PendingAdminChange`**: a governor handover waiting for its successor's acceptance. After the first admission it waits for the delay too, during which the guardian can veto it (custody gap I12). `eta` is the ledger timestamp from which the successor may accept.
- **`LenderAttestation`**: what a lender and a fund's steward both signed: the hash of an off-chain declaration (eligibility, no link with the fund's manager, agreement reference). The document stays off-chain; no personal data goes on chain. `steward` is the steward who co-signed; an approval needs it to still be the fund's steward. `at` is the ledger timestamp of the signature.
- **`PendingStewardRecovery`**: replacement of a lost steward key by the backup the steward registered, proposed by the governor and the guardian, waiting for the longest delay (custody gap I14). `previous` is the steward on record at the proposal and `generation` the governance generation at the proposal; both must still hold at the apply.
- **`PendingStewardBackup`**: replacement of a fund's steward backup, waiting for the delay. The current backup stays valid until it applies. `steward` is the steward who proposed it; a steward change drops the proposal.

## Errors

Error codes are public ABI: new variants are appended, never renumbered or removed.

| Code | Variant | Meaning |
|---|---|---|
| 1 | `NotImplemented` | Kept for ABI stability: returned by entry points of version 1 that waited for the specification. No longer returned. |
| 2 | `FundNotAccepted` | The fund is not in the registry of accepted funds. |
| 3 | `InvalidHaircut` | Haircut must be below 10,000 basis points and within the envelope. |
| 4 | `InvalidAmount` | Amounts must be strictly positive. |
| 5 | `InvalidTerm` | Term must be within the minimum term and the applicable ceiling. |
| 6 | `NoPrice` | The oracle has no price for the asset. |
| 7 | `NotInitialized` | Instance storage lost its configuration. Unreachable with a constructor deployment; kept as a typed failure rather than an opaque trap. |
| 8 | `Paused` | New offers and new repos are suspended. |
| 9 | `StablecoinNotAccepted` | The stablecoin is not in the registry of accepted stablecoins. |
| 10 | `CurrencyMismatch` | Currencies of the fund, its oracles and the stablecoin do not match. |
| 11 | `StalePrice` | The price is older than the freshness window. |
| 12 | `PriceOutOfBand` | The fund's NAV is outside the corridor predicted from its reference. |
| 13 | `LoanTooLarge` | The principal requested exceeds what the shares can secure. |
| 14 | `OfferNotFound` | No such offer. |
| 15 | `InsufficientOffer` | The offer does not hold enough stablecoins. |
| 16 | `RepoNotFound` | No such repo. |
| 17 | `RepoNotOpen` | The repo was already repurchased or seized. |
| 18 | `NotMatured` | The repo has not reached maturity yet. |
| 19 | `CapExceeded` | A per-repo, per-fund or per-currency cap would be exceeded. |
| 20 | `TooManyFunds` | An offer lists no fund, a duplicate, or more than the maximum. |
| 21 | `LenderNotApproved` | The lender or recipient is not approved by the fund's steward. |
| 22 | `TransferMismatch` | The contract did not receive exactly the amount transferred. |
| 23 | `FundNotInOffer` | The offer does not accept this fund as collateral. |
| 24 | `InvalidRate` | Rates are expressed in basis points and capped at 10,000. |
| 25 | `ArithmeticOverflow` | A computation overflowed or divided by zero. |
| 26 | `OutsideEnvelope` | A parameter lies outside the protocol risk envelope. |
| 27 | `FundFrozen` | The fund's steward suspended new repos on this fund. |
| 28 | `InvalidPrice` | A price is not strictly positive or lies in the future. |
| 29 | `DuplicateFund` | Reserved: the fund is already listed in the offer. |
| 30 | `Unauthorized` | The caller does not hold the role this function requires. |
| 31 | `DelayCannotDecrease` | Once a fund has been admitted, the time delay may only grow: a compromised governor cannot shorten the window others have to react. |
| 32 | `NotProposed` | No pending proposal matches: nothing proposed, already applied or cancelled, or an upgrade to another WASM hash than the one proposed. |
| 33 | `TimelockPending` | The proposal exists but its time delay has not elapsed yet. |
| 34 | `ReleaseBlocked` | Reserved: a draft of version 3 returned it from `release`, which now reports a refused delivery as `false` so that the record's TTL extension is kept. No longer returned. |
| 35 | `PriceDivergence` | The fund's NAV feed and its fallback feed disagree by more than the tolerance set for the fallback. |
| 36 | `NothingToRelease` | No shares are waiting to be released for this repo. |
| 37 | `NoFallback` | The fund has no fallback NAV feed. |
| 38 | `ProposalExpired` | The proposal was not applied within its grace period after the eta; it is treated as gone and must be proposed again. |
| 39 | `LimitReached` | A bounded list kept in instance storage is full: funds with a fallback feed, or currencies with a pending cap increase. |
| 40 | `StewardCannotLend` | A fund's steward, its issuer, never lends on its fund: it cannot be approved or attested as a lender there, nor create an offer listing it, and an approved lender cannot become the fund's steward. |
| 41 | `NotSoleLender` | The instance runs in sole-lender mode and the caller is not that lender. |
| 42 | `AttestationMissing` | The lender has no attestation for this fund signed by itself and the fund's current steward: it can be neither approved nor offer on it. |
| 43 | `NotGuardianBackup` | A guardian may hand its role over only to the backup it registered with the governor. |
| 44 | `SoleLenderFixed` | The sole lender can be chosen once, before the first admission and the first offer, and never changes. |
| 45 | `NoStewardBackup` | A steward recovery goes only to the backup the steward registered; none is registered, or the recovery names another address. |
| 46 | `TrusteeFixed` | The trustee is named once, before the first admission and the first offer; afterwards only the trustee hands its role over. |
| 47 | `TrusteeNotIndependent` | The trustee must be neither the governor, the guardian nor the sole lender. |
| 48 | `FxBandExceedsHaircut` | A cross-priced fund's FX band may not exceed its FX haircut: a rate the band admits must stay covered by the haircut. |

## Events

`Upgraded` is published just before the code switches, by the code being replaced. `GuardianChangeForced` records a guardian the governor imposes without the current one, after the longest delay. `AdminChangeProposed` is published with `AdminProposed`, which keeps its version 2 shape, and adds when the proposed governor may accept.
