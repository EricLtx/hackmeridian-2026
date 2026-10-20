// Motion for every Open Window page: staggered entrances, the sliding thumb
// of segmented controls, value flashes when a figure moves (green up, red
// down, like a market screen), toasts, view transitions, the scrolled state
// of the header and the section the reader is in. Everything stays still
// when the system asks for reduced motion.
//
// `readNumber` and `changeOf` are pure and unit-tested; the rest touches the
// page and runs only in the browser.

import { lang, numberStyle } from "./i18n.js";

/** True when the system asks for reduced motion. */
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The first number of a displayed text, read with the decimal separator of
 * the language in use: "1 250,50 tEUR" gives 1250.5 in French. Null when the
 * text holds no number.
 */
export function readNumber(text, decimal = numberStyle().decimal) {
  const match = String(text ?? "").match(/-?\d[\d\s  .,]*/);
  if (!match) return null;
  let raw = match[0].replace(/[\s  ]/g, "").replace(/[.,]$/, "");
  raw = decimal === "." ? raw.replace(/,/g, "") : raw.replace(/\./g, "").replace(",", ".");
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** How a displayed value moved: "up", "down", "same", or "changed" when it is not a number. */
export function changeOf(before, after, decimal) {
  if (before === after) return "same";
  const a = readNumber(before, decimal);
  const b = readNumber(after, decimal);
  if (a === null || b === null) return "changed";
  if (b > a) return "up";
  if (b < a) return "down";
  return "same";
}

// ---------------------------------------------------------------------------
// Browser only
// ---------------------------------------------------------------------------

/** The values shown under `root`, keyed by their data-k attribute, before a re-render. */
export function snapshot(root) {
  const values = new Map();
  for (const el of root.querySelectorAll("[data-k]")) values.set(el.dataset.k, el.textContent);
  return { lang: lang(), values };
}

/** Flashes every keyed value under `root` that moved since `before`. Nothing after a language switch. */
export function flashChanges(root, before) {
  if (!before || before.lang !== lang() || reducedMotion()) return;
  for (const el of root.querySelectorAll("[data-k]")) {
    const previous = before.values.get(el.dataset.k);
    if (previous === undefined) continue;
    const move = changeOf(previous, el.textContent);
    if (move === "same") continue;
    el.classList.remove("flash-up", "flash-down", "flash");
    void el.offsetWidth; // restarts the animation on an element that flashed a moment ago
    el.classList.add(move === "up" ? "flash-up" : move === "down" ? "flash-down" : "flash");
  }
}

/** Plays an entrance once more on `el` (a new ticket, a new tab). */
export function replay(el, className = "is-fresh") {
  if (!el || reducedMotion()) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

/** Runs `update` inside a view transition (a cross-fade) where the browser has them and motion is allowed. */
export function transition(update) {
  if (typeof document.startViewTransition !== "function" || reducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(() => update());
}

/** A short message in the corner, read by screen readers, gone after `timeout`. Tones: info, ok, warn, error. */
export function toast(message, { tone = "info", timeout = 5200 } = {}) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.className = "toasts";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const item = document.createElement("div");
  item.className = `toast toast-${tone}`;
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = { ok: "✓", warn: "!", error: "!", info: "i" }[tone] ?? "i";
  const text = document.createElement("span");
  text.textContent = message;
  item.append(icon, text);
  box.append(item);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => {
    item.classList.add("is-leaving");
    setTimeout(() => item.remove(), reducedMotion() ? 0 : 320);
  }, timeout);
}

/** Shows or hides the thin progress bar at the top of the page. */
export function setLoading(on) {
  document.body.classList.toggle("is-loading", Boolean(on));
}

/** Gives each element of `selector` its rank, which the CSS turns into a staggered delay. */
export function stagger(selector, root = document) {
  let i = 0;
  for (const el of root.querySelectorAll(selector)) el.style.setProperty("--i", String(i++));
}

/**
 * Moves the thumb of every segmented control (view switch, language switch,
 * guide tabs) under its pressed or selected button. The CSS draws the thumb
 * from these variables and slides it; before the first measure, the pressed
 * button paints its own background, so nothing flashes.
 */
export function syncThumbs(root = document) {
  for (const group of root.querySelectorAll(".face-switch, .tabs")) {
    const on = group.querySelector('[aria-pressed="true"], [aria-selected="true"]');
    if (!on || !group.offsetParent) continue;
    group.style.setProperty("--thumb-x", `${on.offsetLeft}px`);
    group.style.setProperty("--thumb-y", `${on.offsetTop}px`);
    group.style.setProperty("--thumb-w", `${on.offsetWidth}px`);
    group.style.setProperty("--thumb-h", `${on.offsetHeight}px`);
    if (!group.classList.contains("has-thumb")) {
      group.classList.add("has-thumb");
      requestAnimationFrame(() => group.classList.add("thumb-ready"));
    }
  }
}

/** Marks the navigation link of the section in view (aria-current) on the guided page. */
function watchSections() {
  const links = [...document.querySelectorAll('.nav a[href^="#"]')];
  const targets = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
  if (!targets.length) return;
  // The current section is the last one whose top has passed under the header.
  let queued = false;
  const update = () => {
    queued = false;
    const line = (document.querySelector(".top")?.offsetHeight ?? 64) + 24;
    let current = null;
    for (const target of targets) if (target.offsetParent !== null && target.getBoundingClientRect().top <= line) current = target.id;
    const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom) current = targets.filter((t) => t.offsetParent !== null).at(-1)?.id ?? current;
    for (const a of links) {
      if (current && a.getAttribute("href") === `#${current}`) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  // The page grows when the data lands: measure again.
  if (typeof ResizeObserver === "function") new ResizeObserver(queue).observe(document.body);
  queue();
}

let started = false;

/** Starts the page-wide motion once: header state, thumbs, staggered entrances, section tracking. */
export function initMotion() {
  if (started || typeof document === "undefined") return;
  started = true;
  // Each group counts from zero: the terminal's panels never wait behind the guided page's cards.
  for (const group of [".intro > *", "main > .card", ".t-grid > .t-panel"]) stagger(group);
  const header = document.querySelector(".top");
  const onScroll = () => header?.classList.toggle("is-scrolled", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  let queued = false;
  const queueThumbs = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      syncThumbs();
    });
  };
  new MutationObserver(queueThumbs).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "aria-selected", "hidden", "class"],
  });
  window.addEventListener("resize", queueThumbs, { passive: true });
  document.fonts?.ready?.then(queueThumbs);
  queueThumbs();
  watchSections();
}
