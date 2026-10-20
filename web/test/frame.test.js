// The page refuses to run inside another site's frame, and only there: in a
// tab of its own, and from the Vite dev server or preview on this machine
// (which an editor may show in a frame), it runs as usual.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refusesFrame } from "../src/frame.js";

/** A window as the check sees it: itself, its top, and its host name. */
function win({ framed, hostname }) {
  const w = { location: { hostname } };
  w.self = w;
  w.top = framed ? { location: { hostname: "clone.example" } } : w;
  return w;
}

test("in a tab of its own the page runs, wherever it is served from", () => {
  for (const hostname of ["ericltx.github.io", "localhost", "127.0.0.1", "[::1]", ""]) {
    assert.equal(refusesFrame(win({ framed: false, hostname })), false, hostname);
  }
});

test("framed by another site, the published page refuses to run", () => {
  assert.equal(refusesFrame(win({ framed: true, hostname: "ericltx.github.io" })), true);
  assert.equal(refusesFrame(win({ framed: true, hostname: "open-window.example" })), true);
  // A srcdoc frame has no host name: it is not this machine.
  assert.equal(refusesFrame(win({ framed: true, hostname: "" })), true);
});

test("the dev server and the preview run even in an editor's frame", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(refusesFrame(win({ framed: true, hostname })), false, hostname);
  }
  // A look-alike host is not this machine.
  assert.equal(refusesFrame(win({ framed: true, hostname: "localhost.example" })), true);
});

test("a top or a location that cannot be read counts as a frame from elsewhere", () => {
  const blockedTop = { location: { hostname: "ericltx.github.io" } };
  blockedTop.self = blockedTop;
  Object.defineProperty(blockedTop, "top", {
    get() {
      throw new Error("blocked");
    },
  });
  assert.equal(refusesFrame(blockedTop), true);
  const blockedLocation = { top: {} };
  blockedLocation.self = blockedLocation;
  Object.defineProperty(blockedLocation, "location", {
    get() {
      throw new Error("blocked");
    },
  });
  assert.equal(refusesFrame(blockedLocation), true);
});
