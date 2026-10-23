// The guided tour (tour.html): the thirteen scenes of tour-scenes.js on
// Reveal.js, in English, French or Spanish. Three scenes read live data
// through the interface's own boundary: the journey replays a repo of the
// indexer's export (history.json), the cost scene takes the best rate of
// the live offers, the live scene reads the board (deployment.js checks the
// deployment file, chain.js every value). No wallet, no signature: the tour
// only reads. Speaker notes show in the page (N) or in a presenter window
// (?presenter=1) kept in step over a BroadcastChannel, since the notes
// plugin of Reveal.js writes inline scripts the page's policy refuses.

// Inter and Inconsolata, served with the page (no font request to a third party).
import "@fontsource-variable/inter";
import "@fontsource-variable/inconsolata";
import "reveal.js/reveal.css";
import Reveal from "reveal.js";
import { Chain } from "./chain.js";
import { checkDeployment } from "./deployment.js";
import { formatAge, formatAmount, formatRate } from "./format.js";
import { refuseFrame, refusesFrame } from "./frame.js";
import { applyStatic, bootLang, markLangButtons, persistLang, setLang, t, tk, tn } from "./i18n.js";
import { esc, exportDecimals } from "./journal.js";
import { reducedMotion } from "./motion.js";
import {
  COMPARE,
  COST_PRESETS,
  EXAMPLE_RATE_BPS,
  ROLES,
  SCENES,
  WEEK_DAYS,
  bestRate,
  costOf,
  freshness,
  isOpen,
  openHours,
  replayRepo,
} from "./tour-scenes.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const PRESENTER = params.get("presenter") === "1";
const AUTOPLAY_MS = 20_000;
const CHANNEL = "openwindow-tour";

/** What the scenes show besides their text: the interactions' state and the live reads, `null` until known. */
const S = {
  week: "hours",
  role: ROLES[0].id,
  tab: 0,
  amount: 10_000,
  hours: 64,
  dep: null,
  decimals: exportDecimals(null),
  offers: null,
  board: null,
  repoCount: null,
  replay: null,
  liveError: null,
};

let deck = null;
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const head = (scene, i) =>
  `<p class="tour-kicker">${esc(t(scene.kicker))}</p><h2 class="tour-title" id="scene-${i}-title">${esc(t(scene.title))}</h2>`;
const body = (scene) => (scene.body ? `<p class="tour-body">${esc(t(scene.body))}</p>` : "");
const fragments = (items, cls = "tour-points") =>
  `<ul class="${cls}">${items.map((text, i) => `<li class="fragment fade-up" data-fragment-index="${i}">${esc(t(text))}</li>`).join("")}</ul>`;

function weekHtml() {
  const rows = WEEK_DAYS.map((day, d) => {
    const cells = Array.from({ length: 24 }, (_, h) => `<span class="${isOpen(S.week, d, h) ? "is-open" : ""}"></span>`).join("");
    return `<div class="week-row"><span class="week-day">${esc(t(day))}</span><span class="week-hours" aria-hidden="true">${cells}</span></div>`;
  }).join("");
  const n = openHours(S.week);
  return `
    <div class="tour-switch" role="group" aria-label="${esc(t("Week view"))}">
      <button type="button" class="face-btn" data-action="week" data-view="hours" aria-pressed="${S.week === "hours"}">${esc(t("Business hours"))}</button>
      <button type="button" class="face-btn" data-action="week" data-view="window" aria-pressed="${S.week === "window"}">${esc(t("Open Window"))}</button>
    </div>
    <div class="week" role="img" aria-label="${esc(t("Credit open {n} of 168 hours a week", { n }))}">${rows}</div>
    <p class="tour-figure" aria-live="polite"><strong>${n}</strong> / 168 ${esc(t("hours a week, open to credit"))}</p>`;
}

function compareHtml() {
  const col = ({ title, items }, cls, from) =>
    `<div class="compare-col ${cls}"><h3>${esc(t(title))}</h3><ul>${items
      .map((text, i) => `<li class="fragment fade-up" data-fragment-index="${from + i}">${esc(t(text))}</li>`)
      .join("")}</ul></div>`;
  return `<div class="compare">${col(COMPARE.before, "is-before", 0)}${col(COMPARE.after, "is-after", COMPARE.before.items.length)}</div>`;
}

function rolesHtml() {
  const role = ROLES.find((r) => r.id === S.role) ?? ROLES[0];
  const chips = ROLES.map(
    (r) => `<button type="button" class="chip" data-action="role" data-role="${r.id}" aria-pressed="${r.id === role.id}">${esc(t(r.name))}</button>`,
  ).join("");
  return `
    <div class="roles-chips" role="group" aria-label="${esc(t("Roles"))}">${chips}</div>
    <div class="roles-detail" aria-live="polite">
      <h3>${esc(t(role.name))}</h3>
      <p class="roles-can"><span class="pill pill-ok">${esc(t("Can"))}</span> ${esc(t(role.can))}</p>
      <p class="roles-never"><span class="pill pill-danger">${esc(t("Never"))}</span> ${esc(t(role.never))}</p>
    </div>`;
}

function journeyHtml(scene) {
  const steps = scene.steps
    .map(
      ([label, text], i) =>
        `<li class="fragment fade-up" data-fragment-index="${i}"><span class="step-mark">${i + 1}</span><strong>${esc(t(label))}</strong><span>${esc(t(text))}</span></li>`,
    )
    .join("");
  return `<div class="journey"><ol class="journey-steps">${steps}</ol><div class="journey-replay" id="tour-replay">${replayHtml()}</div></div>`;
}

function replayHtml() {
  const r = S.replay;
  if (!r) return `<p class="muted">${esc(t("The public record of this instance is loading."))}</p>`;
  const d = S.decimals.stablecoin;
  const code = S.decimals.code;
  return `
    <p class="tour-kicker">${esc(t("A real repo, from the public record"))}</p>
    <h3>${esc(t("Repo #{id}", { id: r.id }))}</h3>
    <dl class="facts">
      <dt>${esc(t("Borrowed"))}</dt><dd class="num">${esc(formatAmount(r.principal, d))} ${esc(code)}</dd>
      <dt>${esc(t("Rate"))}</dt><dd class="num">${esc(formatRate(r.rateBps))} ${esc(t("a year"))}</dd>
      <dt>${esc(t("Hours charged"))}</dt><dd class="num">${esc(String(r.hours))}</dd>
      <dt>${esc(t("Interest paid"))}</dt><dd class="num">${esc(formatAmount(r.interest, d))} ${esc(code)}</dd>
      <dt>${esc(t("Opened"))}</dt><dd class="num">${esc(r.openedAt.replace("T", " ").replace("Z", " UTC"))}</dd>
      <dt>${esc(t("Bought back"))}</dt><dd class="num">${esc(r.closedAt.replace("T", " ").replace("Z", " UTC"))}</dd>
    </dl>`;
}

function costHtml() {
  const presets = COST_PRESETS.map(
    ([label, hours]) => `<button type="button" class="chip" data-action="hours" data-hours="${hours}" aria-pressed="${S.hours === hours}">${esc(t(label))}</button>`,
  ).join("");
  return `
    <div class="cost">
      <div class="cost-inputs">
        <label for="tour-amount">${esc(t("Amount to borrow"))}</label>
        <div class="input-unit"><input id="tour-amount" type="number" inputmode="numeric" min="1" step="1" value="${S.amount}" /><span class="unit" id="tour-amount-unit">${esc(S.decimals.code || t("units"))}</span></div>
        <label for="tour-hours">${esc(t("Duration"))}: <strong id="tour-hours-out">${esc(tn("{n} hour", "{n} hours", S.hours))}</strong></label>
        <input id="tour-hours" type="range" min="1" max="168" step="1" value="${S.hours}" />
        <div class="cost-presets" role="group" aria-label="${esc(t("Durations"))}">${presets}</div>
      </div>
      <div class="cost-out" id="tour-cost-out" aria-live="polite">${costOutHtml()}</div>
    </div>`;
}

function costOutHtml() {
  const live = S.offers ? bestRate(S.offers) : null;
  const rate = live ?? EXAMPLE_RATE_BPS;
  const d = S.decimals.stablecoin;
  const code = S.decimals.code;
  const amount = Number.isFinite(S.amount) && S.amount >= 1 ? Math.floor(S.amount) : 1;
  const { interest, total } = costOf(BigInt(amount) * 10n ** BigInt(d), rate, S.hours);
  const source = live !== null ? t("best live offer, {rate} a year", { rate: formatRate(rate) }) : t("example rate, {rate} a year: no live offer could be read", { rate: formatRate(rate) });
  return `
    <p class="tour-kicker">${esc(t("Interest for {hours}", { hours: tn("{n} hour", "{n} hours", S.hours) }))}</p>
    <p class="cost-figure num">${esc(formatAmount(interest, d, "ceil"))} <span>${esc(code)}</span></p>
    <p class="muted">${esc(t("To repay: {total} {code}", { total: formatAmount(total, d, "ceil"), code }))}</p>
    <p class="cost-source"><span class="pill ${live !== null ? "pill-ok" : "pill-warn"}">${esc(live !== null ? t("Live") : t("Example"))}</span> ${esc(source)}</p>`;
}

function liveHtml() {
  if (S.liveError) {
    return `<p class="notice">${esc(t("The chain could not be read just now ({reason}). The History page keeps the full record.", { reason: S.liveError }))}</p>`;
  }
  const b = S.board;
  if (!b) return `<p class="muted">${esc(t("Reading the testnet instance…"))}</p>`;
  const now = b.now?.value ?? null;
  const funds = (b.funds ?? [])
    .map((f) => {
      const fr = f.nav && now !== null ? freshness(f.nav.timestamp, f.maxAge, now) : null;
      const state = fr === null ? `<span class="pill pill-muted">${esc(t("unknown"))}</span>` : fr.fresh ? `<span class="pill pill-ok">${esc(t("fresh"))}</span>` : `<span class="pill pill-warn">${esc(t("stale"))}</span>`;
      const age = fr === null ? "—" : formatAge(Number(f.nav.timestamp), Number(now));
      return `<li><strong>${esc(f.symbol)}</strong> ${state} <span class="muted">${esc(t("price published {age}", { age }))}</span></li>`;
    })
    .join("");
  const offers = S.offers ?? [];
  const rate = bestRate(offers);
  const paused = b.paused?.value === true;
  return `
    <div class="tour-tiles">
      <div class="tile"><div class="tile-label">${esc(t("Contract"))}</div><div class="tile-value">${esc(paused ? t("Paused") : t("Open"))}</div><div class="tile-sub">${esc(paused ? t("new loans stopped; buying back stays open") : t("open to new loans"))}</div></div>
      <div class="tile"><div class="tile-label">${esc(t("Offers"))}</div><div class="tile-value num">${offers.length}</div><div class="tile-sub">${esc(rate === null ? t("none with funds left") : t("best {rate} a year", { rate: formatRate(rate) }))}</div></div>
      <div class="tile"><div class="tile-label">${esc(t("Repos on record"))}</div><div class="tile-value num">${S.repoCount ?? "—"}</div><div class="tile-sub"><a href="./history.html">${esc(t("Read the history"))}</a></div></div>
    </div>
    <h3>${esc(t("Admitted funds and the age of their price"))}</h3>
    <ul class="tour-funds">${funds}</ul>`;
}

function safetyHtml(scene) {
  const tabs = scene.tabs
    .map(
      ([label], i) =>
        `<button type="button" class="tab" role="tab" id="tour-tab-${i}" aria-controls="tour-panel" aria-selected="${S.tab === i}" tabindex="${S.tab === i ? 0 : -1}" data-action="tab" data-tab="${i}">${esc(t(label))}</button>`,
    )
    .join("");
  const [, text] = scene.tabs[S.tab] ?? scene.tabs[0];
  return `<div class="tabs" role="tablist" aria-label="${esc(t("Safeguards"))}">${tabs}</div>
    <div class="tour-panel" id="tour-panel" role="tabpanel" aria-labelledby="tour-tab-${S.tab}" aria-live="polite"><p>${esc(t(text))}</p></div>`;
}

function questionsHtml(scene) {
  return `<div class="tour-faq">${scene.faq
    .map(([q, a]) => `<details class="terms"><summary>${esc(t(q))}</summary><p>${esc(t(a))}</p></details>`)
    .join("")}</div>`;
}

function roadmapHtml(scene) {
  return `<ol class="roadmap">${scene.phases
    .map(
      ([label, text], i) =>
        `<li class="fragment fade-up${i === 0 ? " is-done" : ""}" data-fragment-index="${i}"><strong>${esc(t(label))}</strong><span>${esc(t(text))}</span></li>`,
    )
    .join("")}</ol>`;
}

function ctaHtml(scene) {
  return `<div class="tour-doors">${scene.doors
    .map(([label, href], i) => `<a class="btn ${i === 0 ? "btn-primary" : "btn-ghost"} btn-lg" href="${href}">${esc(t(label))}</a>`)
    .join("")}</div><p class="tour-credit">${esc(t("Images: NASA"))}</p>`;
}

const CONTENT = {
  title: () => `<img class="tour-earth" src="./tour/earth.webp" alt="" width="1280" height="720" decoding="async" /><div class="tour-actions"><button type="button" class="btn btn-primary btn-lg" data-action="start">${esc(t("Start the tour"))}</button><button type="button" class="btn btn-ghost btn-lg" data-action="autoplay">${esc(t("Let it present itself"))}</button></div><p class="tour-credit">${esc(t("Images: NASA"))}</p>`,
  hook: (s) => fragments(s.points),
  context: () => `<div id="tour-week">${weekHtml()}</div>`,
  problem: (s) => fragments(s.points),
  insight: () => compareHtml(),
  roles: () => `<div id="tour-roles">${rolesHtml()}</div>`,
  journey: (s) => journeyHtml(s),
  cost: () => costHtml(),
  live: () => `<div id="tour-live" aria-live="polite">${liveHtml()}</div>`,
  safety: (s) => `<div id="tour-safety">${safetyHtml(s)}</div>`,
  questions: (s) => questionsHtml(s),
  roadmap: (s) => roadmapHtml(s),
  cta: (s) => ctaHtml(s),
};

function sceneHtml(scene, i) {
  return `<section class="tour-scene tour-k-${scene.kind}" data-scene="${scene.id}" aria-labelledby="scene-${i}-title">
    ${head(scene, i)}${body(scene)}${CONTENT[scene.kind](scene)}
  </section>`;
}

const render = () => {
  $("tour-slides").innerHTML = SCENES.map(sceneHtml).join("");
};

/** Redraws one interactive block in place, keeping the deck where it is. */
function redraw(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Speaker notes
// ---------------------------------------------------------------------------

function notesHtml(i) {
  const scene = SCENES[i];
  if (!scene) return "";
  const n = scene.notes;
  const next = SCENES[i + 1];
  const row = (label, text) => `<dt>${esc(t(label))}</dt><dd>${esc(t(text))}</dd>`;
  return `<p class="tour-kicker">${esc(t("Scene {n} of {total}", { n: i + 1, total: SCENES.length }))}: ${esc(t(scene.title))}</p>
    <dl class="notes-list">
      ${row(tk("Message"), n.key)}${row(tk("Say"), n.say)}${row(tk("Stress"), n.stress)}${row(tk("Likely question"), n.question)}${row(tk("Answer"), n.answer)}${row(tk("Next"), n.next)}
    </dl>
    ${next ? `<p class="muted">${esc(t("Next scene: {title}", { title: t(next.title) }))}</p>` : ""}`;
}

function showNotes() {
  const panel = $("tour-notes");
  if (panel && !panel.hidden && deck) panel.innerHTML = notesHtml(deck.getIndices().h);
}

function toggleNotes() {
  const panel = $("tour-notes");
  panel.hidden = !panel.hidden;
  $("notes-btn").setAttribute("aria-pressed", String(!panel.hidden));
  showNotes();
}

// ---------------------------------------------------------------------------
// Interactions (delegated, so a redraw keeps them working)
// ---------------------------------------------------------------------------

function onClick(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "start") deck.next();
  else if (action === "autoplay") {
    deck.configure({ autoSlide: AUTOPLAY_MS, loop: true });
    deck.next();
  } else if (action === "week") {
    S.week = el.dataset.view === "window" ? "window" : "hours";
    redraw("tour-week", weekHtml());
  } else if (action === "role") {
    S.role = ROLES.some((r) => r.id === el.dataset.role) ? el.dataset.role : ROLES[0].id;
    redraw("tour-roles", rolesHtml());
    document.querySelector(`[data-role="${S.role}"]`)?.focus();
  } else if (action === "tab") selectTab(Number(el.dataset.tab));
  else if (action === "hours") setHours(Number(el.dataset.hours));
}

function selectTab(i) {
  const scene = SCENES.find((s) => s.kind === "safety");
  S.tab = ((i % scene.tabs.length) + scene.tabs.length) % scene.tabs.length;
  redraw("tour-safety", safetyHtml(scene));
  $(`tour-tab-${S.tab}`)?.focus();
}

function setHours(hours) {
  S.hours = Math.min(168, Math.max(1, Math.round(hours) || 1));
  const range = $("tour-hours");
  if (range) range.value = String(S.hours);
  const out = $("tour-hours-out");
  if (out) out.textContent = tn("{n} hour", "{n} hours", S.hours);
  for (const chip of document.querySelectorAll('[data-action="hours"]')) chip.setAttribute("aria-pressed", String(Number(chip.dataset.hours) === S.hours));
  redraw("tour-cost-out", costOutHtml());
}

function onInput(event) {
  if (event.target.id === "tour-hours") setHours(Number(event.target.value));
  else if (event.target.id === "tour-amount") {
    const value = Number(event.target.value);
    S.amount = Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 1_000_000_000) : 1;
    redraw("tour-cost-out", costOutHtml());
  }
}

function onKeydown(event) {
  // Arrow keys move between the safeguard tabs (WAI-ARIA tabs pattern) without turning the scene.
  const tab = event.target.closest?.('[data-action="tab"]');
  if (tab && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    event.preventDefault();
    event.stopPropagation();
    selectTab(S.tab + (event.key === "ArrowRight" ? 1 : -1));
  }
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

async function loadLive() {
  try {
    const response = await fetch("./deployment.testnet.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    S.dep = checkDeployment(await response.json());
    S.decimals = exportDecimals(S.dep);
    redraw("tour-amount-unit", esc(S.decimals.code || t("units")));
    const chain = new Chain(S.dep);
    const board = await chain.board(0n);
    S.offers = board.offers?.value ?? null;
    const now = board.now?.value ?? null;
    // Each fund's price and the age the contract accepts, read like the board's funds.
    const funds = await Promise.all(
      (board.funds ?? []).map(async (f) => {
        const feeds = f.config?.value ? await chain.feeds(f.shares, f.config.value).catch(() => null) : null;
        return { symbol: f.symbol, nav: feeds?.nav?.value ?? null, maxAge: f.config?.value?.nav_max_age_secs ?? 0 };
      }),
    );
    S.board = { ...board, now: { value: now }, funds };
    S.repoCount = (await chain.readRepos().catch(() => null))?.repos.length ?? null;
    // The replay may have been drawn before the deployment file gave the stablecoin's code and decimals.
    if (S.replay) redraw("tour-replay", replayHtml());
  } catch (error) {
    S.liveError = String(error?.message ?? error).slice(0, 120);
  }
  redraw("tour-live", liveHtml());
  redraw("tour-cost-out", costOutHtml());
}

async function loadReplay() {
  try {
    const response = await fetch("./history.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    S.replay = replayRepo((await response.json())?.registry);
  } catch {
    S.replay = null;
  }
  redraw("tour-replay", S.replay ? replayHtml() : `<p class="muted">${esc(t("The public record could not be loaded; the History page shows it."))}</p>`);
}

// ---------------------------------------------------------------------------
// Presenter window
// ---------------------------------------------------------------------------

let presenterIndex = 0;

function drawPresenter() {
  $("presenter-notes").innerHTML = notesHtml(presenterIndex);
  const jump = $("presenter-jump");
  jump.innerHTML = SCENES.map((s, i) => `<option value="${i}">${i + 1}. ${esc(t(s.title))}</option>`).join("");
  jump.value = String(presenterIndex);
}

function bootPresenter() {
  document.body.classList.add("tour-presenter");
  $("tour-deck").hidden = true;
  $("presenter").hidden = false;
  const started = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    $("presenter-clock").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  };
  setInterval(tick, 1000);
  tick();
  drawPresenter();
  channel?.addEventListener("message", (event) => {
    if (Number.isInteger(event.data?.index)) {
      presenterIndex = Math.min(Math.max(event.data.index, 0), SCENES.length - 1);
      drawPresenter();
    }
  });
  const go = (to) => channel?.postMessage({ go: Math.min(Math.max(to, 0), SCENES.length - 1) });
  $("presenter-prev").addEventListener("click", () => go(presenterIndex - 1));
  $("presenter-next").addEventListener("click", () => go(presenterIndex + 1));
  $("presenter-jump").addEventListener("change", (event) => go(Number(event.target.value)));
  channel?.postMessage({ hello: true });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function relabel() {
  applyStatic();
  markLangButtons();
  document.title = t("Open Window, guided tour");
}

async function start() {
  if (refusesFrame(window)) return refuseFrame(document);
  bootLang();
  relabel();
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      setLang(button.dataset.lang);
      persistLang();
      relabel();
      if (PRESENTER) return drawPresenter();
      const { h, f } = deck.getIndices();
      render();
      deck.sync();
      deck.slide(h, 0, f);
      showNotes();
    });
  }
  render();
  if (PRESENTER) return bootPresenter();

  const reduced = reducedMotion();
  // A phone held upright gets a portrait canvas, so the text is not scaled down to a third.
  const narrow = window.matchMedia("(max-width: 760px)").matches;
  deck = new Reveal($("tour-deck"), {
    hash: true,
    hashOneBasedIndex: true,
    controls: true,
    controlsTutorial: false,
    progress: true,
    slideNumber: "c/t",
    center: true,
    width: narrow ? 600 : 1280,
    height: narrow ? 1000 : 760,
    margin: narrow ? 0.03 : 0.05,
    transition: reduced ? "none" : "fade",
    transitionSpeed: "fast",
    backgroundTransition: "none",
    autoSlide: params.get("autoplay") === "1" ? AUTOPLAY_MS : 0,
    autoSlideStoppable: true,
    loop: params.get("autoplay") === "1",
    help: true,
    pdfSeparateFragments: false,
    keyboard: { 78: toggleNotes },
  });
  await deck.initialize();
  const slides = $("tour-slides");
  slides.addEventListener("click", onClick);
  slides.addEventListener("input", onInput);
  slides.addEventListener("keydown", onKeydown, true);
  $("notes-btn").addEventListener("click", toggleNotes);
  deck.on("slidechanged", () => {
    showNotes();
    channel?.postMessage({ index: deck.getIndices().h });
  });
  channel?.addEventListener("message", (event) => {
    if (Number.isInteger(event.data?.go)) deck.slide(event.data.go);
    else if (event.data?.hello) channel.postMessage({ index: deck.getIndices().h });
  });
  loadReplay();
  loadLive();
}

start();
