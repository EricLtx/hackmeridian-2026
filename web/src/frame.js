// The page refuses to run inside another site's frame. GitHub Pages cannot
// send the frame-ancestors header, and a meta CSP cannot carry it, so a site
// that framed the page could overlay it and collect clicks on its prefilled
// forms; the check is made here instead. Pure apart from `refuseFrame`,
// which replaces the page's content.

import { t } from "./i18n.js";

/** Host names of a page served from this machine: the Vite dev server and `vite preview`, which an editor may show in a frame. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the page must refuse to run: it is inside a frame (`top !==
 * self`) and served from anywhere but this machine. A top that cannot be
 * compared counts as a frame. In a tab of its own the page always runs.
 */
export function refusesFrame(win) {
  let framed;
  try {
    framed = win.top !== win.self;
  } catch {
    framed = true;
  }
  if (!framed) return false;
  let host = "";
  try {
    host = String(win.location?.hostname ?? "");
  } catch {
    host = "";
  }
  return !LOCAL_HOSTS.has(host);
}

/** Blanks the page with a short message and a link that opens it in a tab of its own. */
export function refuseFrame(doc) {
  const notice = doc.createElement("p");
  notice.className = "notice notice-error";
  notice.textContent = `${t("Open Window runs only in a tab of its own, not inside another site.")} `;
  const link = doc.createElement("a");
  link.href = doc.location.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t("Open it in a new tab");
  notice.append(link);
  const main = doc.createElement("main");
  main.className = "wrap";
  main.append(notice);
  doc.body.replaceChildren(main);
}
