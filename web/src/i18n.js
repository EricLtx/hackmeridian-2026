// Interface languages. English is the source text: every string shown is
// written in English in the code and looked up, as is, in the French and
// Spanish dictionaries (src/locales/). A missing translation shows the
// English text. `{name}` placeholders are filled after the lookup, so a
// translation can move them where its grammar needs them.
//
// Pure apart from `applyStatic`, `bootLang`, `persistLang` and `markLangButtons`,
// which touch the page and are only called in the browser.

import fr from "./locales/fr/index.js";
import es from "./locales/es/index.js";

export const LANGS = ["en", "fr", "es"];

/** Each language named in itself, for the switch. */
export const LANG_NAMES = { en: "English", fr: "Français", es: "Español" };

/** Where the choice is kept on the device. */
export const LANG_KEY = "openwindow.lang";

const DICTS = { en: null, fr, es };
const LOCALES = { en: "en-GB", fr: "fr-FR", es: "es-ES" };

/**
 * Number style per language. `group` separates thousands (French uses a
 * no-break space, which keeps a number on one line and its width in a
 * monospaced font); `minGroup` is the number of integer digits from which
 * thousands are grouped (Spanish writes 1000 but 10.000).
 */
const NUMBERS = {
  en: { group: ",", decimal: ".", minGroup: 4 },
  fr: { group: " ", decimal: ",", minGroup: 4 },
  es: { group: ".", decimal: ",", minGroup: 5 },
};

let current = "en";

/** The language in use: "en", "fr" or "es". */
export const lang = () => current;

/** The BCP 47 locale for dates and plural rules. */
export const locale = () => LOCALES[current];

/** Separators of the language in use. */
export const numberStyle = () => NUMBERS[current];

/** Switches language; anything unknown falls back to English. Returns the language set. */
export function setLang(code) {
  current = LANGS.includes(code) ? code : "en";
  return current;
}

/** The first supported language among candidates such as "fr-CA" or "es"; English when none is. */
export function pickLang(candidates = []) {
  for (const candidate of candidates) {
    const base = String(candidate ?? "").toLowerCase().split(/[-_]/)[0];
    if (LANGS.includes(base)) return base;
  }
  return "en";
}

/** The language to open with: the URL (?lang=fr) first, then the remembered choice, then the browser's languages. */
export function initialLang({ search = "", stored = null, preferred = [] } = {}) {
  const asked = new URLSearchParams(search).get("lang");
  if (LANGS.includes(asked)) return asked;
  if (LANGS.includes(stored)) return stored;
  return pickLang(preferred);
}

const fill = (text, params) =>
  params ? text.replace(/\{(\w+)\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match)) : text;

/** The text in the language in use, its `{name}` placeholders filled from `params`. */
export function t(text, params) {
  const dict = DICTS[current];
  const found = dict ? dict[text] : undefined;
  return fill(typeof found === "string" && found ? found : text, params);
}

/** Marks a text for translation where it is defined (a table, a constant); `t` translates it where it is shown. */
export const tk = (text) => text;

/**
 * Like `t`, for a short English text whose translation depends on where it
 * is shown ("none" agrees with the noun it qualifies). The dictionary entry is
 * `"<context>\u0004<text>"`, the separator gettext uses; English shows the text.
 */
export function tc(context, text, params) {
  const dict = DICTS[current];
  const found = dict ? dict[`${context}\u0004${text}`] : undefined;
  return typeof found === "string" && found ? fill(found, params) : t(text, params);
}

/** Singular or plural by the rule of the language in use (French counts 0 as singular); `{n}` is the count. */
export function tn(one, other, n, params = {}) {
  const form = new Intl.PluralRules(LOCALES[current]).select(Number(n));
  return t(form === "one" ? one : other, { n, ...params });
}

/** The dictionaries, for the completeness check. */
export const dictionaries = () => ({ fr, es });

// ---------------------------------------------------------------------------
// Browser only
// ---------------------------------------------------------------------------

const originals = new WeakMap();

/**
 * Translates the static text of the page. `data-i18n` translates the text of
 * an element whose content is plain text; `data-i18n-html` its inner HTML
 * (static markup such as <code>); `data-i18n-attr="title aria-label"` the
 * listed attributes. The English originals are kept, so switching back and
 * forth always starts from the source.
 */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll("[data-i18n], [data-i18n-html], [data-i18n-attr]")) {
    let source = originals.get(el);
    if (!source) {
      source = {
        text: el.hasAttribute("data-i18n") ? el.textContent.replace(/\s+/g, " ").trim() : null,
        html: el.hasAttribute("data-i18n-html") ? el.innerHTML.replace(/\s+/g, " ").trim() : null,
        attrs: {},
      };
      for (const name of (el.getAttribute("data-i18n-attr") ?? "").split(/\s+/).filter(Boolean)) source.attrs[name] = el.getAttribute(name);
      originals.set(el, source);
    }
    if (source.text !== null) el.textContent = t(source.text);
    if (source.html !== null) el.innerHTML = t(source.html);
    for (const [name, value] of Object.entries(source.attrs)) if (value !== null) el.setAttribute(name, t(value));
  }
  document.documentElement.lang = current;
}

/** Sets the language from the URL, the device or the browser. Call before the first render. */
export function bootLang() {
  let stored = null;
  try {
    stored = localStorage.getItem(LANG_KEY);
  } catch {
    // Storage blocked: the URL and the browser decide.
  }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  return setLang(initialLang({ search: window.location.search, stored, preferred }));
}

/** Keeps the language in use on the device and in the URL, so a shared link opens in it. */
export function persistLang() {
  try {
    localStorage.setItem(LANG_KEY, current);
  } catch {
    // Storage blocked: the URL still carries the choice.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("lang", current);
  window.history.replaceState(null, "", url);
}

/** Marks the pressed language button of the switch. */
export function markLangButtons(root = document) {
  for (const button of root.querySelectorAll("[data-lang]")) button.setAttribute("aria-pressed", String(button.dataset.lang === current));
}
