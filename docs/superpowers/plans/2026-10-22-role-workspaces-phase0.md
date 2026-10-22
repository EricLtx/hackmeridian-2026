# Role workspaces, phase 0 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five interface defects found on 22 October, recognise the connected wallet's roles from the chain, and add a read-only Operate space (health, roles, pending proposals with countdowns), before the web freeze of 24 October 2026, 18:00.

**Architecture:** Pure modules for everything testable (`src/roles.js`, `src/operate.js`, label tables in `src/blotter.js`, `effectiveHaircutBps` in `src/terms.js`), thin reads in `src/chain.js`, wiring in `src/main.js` and `index.html`. Reads for the Operate space are throttled to one pass a minute. No contract change, no new dependency, no new endpoint.

**Tech Stack:** Vite 8, plain JavaScript (ES modules), `@stellar/stellar-sdk` 17, `@stellar/freighter-api` 6, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-22-role-workspaces-design.md`; defects from `web/DESIGN.md` (gaps 1 and 2) and the UX pass of 22 October (status band, total haircut, untranslated tape events).

## Global Constraints

- Contract frozen at `audit-v4-rc5`: only existing entry points.
- Every visible string in English through `t()`, with French and Spanish entries in `src/locales/{fr,es}/<module>.js`; `npm run check:i18n` passes.
- Values read from the chain are untrusted: a failed or malformed read shows a dash or "unknown", never a role or a value it did not read.
- `npm test` and `npm run build` pass in `web/`; CI green before the freeze.
- Commits end with the session's attribution lines; `main` is fast-forwarded from `rc5/docs` after CI.

## Review Focus

1. A wallet that is a governor signer with weight 0 must not be shown as governor.
2. A read error on one role (RPC timeout) must leave that role "unknown" and keep the others.
3. A proposal whose `eta` is in the past shows "can apply now", not a negative countdown.
4. An event name added to the contract later still renders (generic line), and every current event has a translated label.
5. The Operate reads must not slow the 15 s pass: one read a minute, and a failure there never fails the pass.

---

### Task 1: The terminal status band survives a fractional RPC time

**Files:** Modify `src/terminal.js:646`. Test `test/terminal.test.js`.

- [ ] **Step 1: failing test** `the status band shows an RPC time with decimals`: mount with `rpcInfo` answering `ms: 147.7`; assert the band holds `148` and not the unshowable note.
- [ ] **Step 2:** run `node --test test/terminal.test.js`: FAIL (RangeError caught, note shown).
- [ ] **Step 3:** round before `BigInt`: `BigInt(Math.round(rpcNow.ms))`.
- [ ] **Step 4:** run again: PASS. **Step 5:** commit.

### Task 2: One haircut figure, the total, wherever a loan's cut is stated

**Files:** Modify `src/terms.js` (export `effectiveHaircutBps(config)`), `src/main.js` (guide context, funds table), `src/guide.js` (no change of text). Test `test/guide.test.js`.

**Interfaces:** Produces `effectiveHaircutBps(config) -> number | null`: `haircut_bps` plus the cross leg's `haircut_bps` when `source` is `["Cross", { haircut_bps }]`; `null` for a missing config.

- [ ] **Step 1: failing tests** `effectiveHaircutBps adds the exchange-rate leg` (200 + 200 → 400; Direct 150 → 150; null → null).
- [ ] **Step 2:** FAIL (not exported). **Step 3:** implement; use it in `renderGuide` (`haircutBps`) and in the funds table's haircut cell, which shows the total and, for a cross fund, "(x + y on the exchange rate)".
- [ ] **Step 4:** PASS; `npm run check:i18n`. **Step 5:** commit.

### Task 3: Every contract event has a translated tape label

**Files:** Modify `src/blotter.js` (an `EVENT_LABELS` table used by the generic line), `src/locales/fr/blotter.js`, `src/locales/es/blotter.js`. Test `test/blotter.test.js`.

- [ ] **Step 1: failing tests** `every contract event has a label or a row` (reads the struct names of `contracts/night-window/src/events.rs`, snake-cases them, checks each is a row or in `EVENT_LABELS`); `in French a cancelled stablecoin change reads in French` (no English subject left).
- [ ] **Step 2:** FAIL (35 events without label). **Step 3:** add the 35 labels (`admin_proposed`, `reanchor_proposed`, `stablecoin_change_cancelled`, …) as `t()` literals, and their French and Spanish entries; the generic line uses the label, else the event name.
- [ ] **Step 4:** PASS; `npm run check:i18n`. **Step 5:** commit.

### Task 4: Control outlines at 3:1 and 44 px targets on touch screens

**Files:** Modify `src/style.css` (`.chip`, `.btn-ghost`, `.step-mark`, `.term kbd` outlines on `--input-border`; one `@media (pointer: coarse)` block). Test: create `test/design.test.js`.

- [ ] **Step 1: failing tests** `interactive outlines reach 3:1 in every palette` (parses the stylesheet: those selectors' border colours resolve to a token whose contrast with `--surface` is at least 3 in light, dark and terminal) and `touch screens get 44 px targets` (the coarse-pointer block sets `min-height` ≥ 44 px on `.face-btn`, `.btn-small`, `.input-small input`, `.chip`, `.t-key`, `.tab`, `.lang-btn`).
- [ ] **Step 2:** FAIL. **Step 3:** change the four outlines; add the block. **Step 4:** PASS; `npm run build`. **Step 5:** commit.

### Task 5: Role recognition

**Files:** Create `src/roles.js`; modify `src/chain.js` (`roleFacts(funds, address)`, `accountSigners(address)`); modify `src/main.js` (wallet card chips). Test: create `test/roles.test.js`. Locales: `src/locales/{fr,es}/roles.js`, registered in each `index.js`.

**Interfaces:** Produces `rolesOf(address, facts) -> { held: [{ role, fund? }], unknown: [role] }` with roles `governor`, `guardian`, `guardianBackup`, `sentinel`, `trustee`, `soleLender`, `steward`, `stewardBackup`, `approvedLender`; `facts` = `{ admin, adminSigners, guardian, guardianBackup, sentinel, trustee, soleLender, funds: [{ symbol, steward, stewardBackup, approved }] }`, each a `{ value } | { error }` read. `roleName(role) -> string` (translated). `chain.roleFacts(funds, address)` returns that `facts`; `chain.accountSigners(address)` reads the account's ledger entry and returns `[{ key, weight }]` including the master key.

- [ ] **Step 1: failing tests** `a governor signer with weight counts, weight 0 does not`; `a failed read leaves the role unknown and grants nothing`; `stewardship is per fund`; `an approved lender is per fund`; `the governor account itself is governor`.
- [ ] **Step 2:** FAIL (no module). **Step 3:** implement `rolesOf` and `roleName`; implement the two chain reads with `settle` and `getLedgerEntries`; on wallet adoption and every pass, `S.roles = rolesOf(...)`; the wallet card shows one chip per held role.
- [ ] **Step 4:** PASS; check:i18n. **Step 5:** commit.

### Task 6: The Operate space, read-only

**Files:** Create `src/operate.js`; modify `src/chain.js` (`pendingAll(funds)` = `pendingChanges` plus forced guardian, per-fund limits, backup feed, re-anchor, steward backup, steward recovery); modify `src/main.js` (`refreshOperate`, throttled to 60 s, failures contained; `renderOperate`); modify `index.html` (nav link "Operate", section `#operate`). Test: create `test/operate.test.js`. Locales `src/locales/{fr,es}/operate.js`.

**Interfaces:** Consumes `rolesOf`, `roleName` (Task 5), `effectiveHaircutBps` (Task 2). Produces `operateModel({ facts, pending, board, now }) -> { health: [{ label, value, tone }], roles: [{ role, address, fund?, you }], proposals: [{ label, eta, due }] }` and `operateMarkup(model, { wallet }) -> string`.

- [ ] **Step 1: failing tests** `proposals are sorted by the moment they can apply, a past one reads "can apply now"`; `a NAV older than its bound is a warning in health`; `the roles list marks the connected wallet`; `an unreadable role shows unknown, not an address`.
- [ ] **Step 2:** FAIL. **Step 3:** implement; the section shows three panels (Health, Roles, Proposals) and a line saying the actions arrive in a later version and run today through the operator's tooling.
- [ ] **Step 4:** PASS; check:i18n; build. **Step 5:** commit.

### Task 7: Verify on the page, document, ship

**Files:** Modify `web/DESIGN.md` (gaps 1 and 2 closed), `web/README.md` (the Operate space), `docs/superpowers/specs/2026-10-22-role-workspaces-design.md` (phase 0 status).

- [ ] **Step 1:** `npm test`, `npm run check:i18n`, `npm run build` in `web/`: all pass.
- [ ] **Step 2:** `npm run preview`, open the page: terminal band without the red line; guide says 4.00 %; tape in French has no English subject; Operate shows roles and proposals.
- [ ] **Step 3:** commit, fast-forward `main`, push; CI and Pages green; check the published page once more.
