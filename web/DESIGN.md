# Open Window web: design system

What the interface is made of, visually: the tokens, the components, the rules they follow, and where they fall short. Everything lives in one stylesheet, `src/style.css`; this page describes it as of 24 October 2026 and is the reference for any change to it. Since 24 October 2026 the foundations are those of the [Stellar Design System](https://github.com/stellar/stellar-design-system) (SDS, `@stellar/design-system` 4.0.2): its colour scales, its fonts and its 14 and 16 px base sizes. The SDS ships React components; this interface is plain JavaScript, so it adopts the SDS tokens and state patterns in CSS, not the components. Measured with a script over the stylesheet (contrast ratios computed from the token values, WCAG 2.2 formula), not by eye.

## Principles

Calm, legible, finance-grade. Clean surfaces and one accent (SDS lilac); a lilac-to-navy gradient used sparingly; Inter for text and Inconsolata for figures and identifiers. Motion is short and eased, and stops when the system asks for reduced motion. Two faces of one state: the **guided view** follows the system theme (light or dark); the **terminal view** is a dark market screen whatever the theme, with amber commands, a green GO key and a red CANCEL key, as on a market terminal. The **guided tour** (`tour.html`) is a dark stage (`body.face-stage`) on the dark steps of the guided view, for meeting-room screens; its planets (`.tour-planet`, sized and timed by the component-scoped `--planet-d` and `--planet-spin`, which are not design tokens) sit beside the text and turn only under `prefers-reduced-motion: no-preference`.

## Tokens

All colours, radii, shadows and easings are custom properties on `:root`, redefined for the dark theme (`prefers-color-scheme: dark`) and for the terminal face. 313 rules read them through `var(--…)`.

### Colour

Each value is a step of an SDS scale (Radix convention: steps 1–2 page backgrounds, 3–5 component backgrounds, 6–8 borders, 9–10 solid fills, 11 low-contrast text, 12 high-contrast text). The stylesheet names the step next to each value, and `test/design.test.js` checks that every palette value is one of them.

| Token | Light | Dark | Terminal | Use |
|---|---|---|---|---|
| `--bg` | gray-02 `#f8f8f8` | gray-01 `#161616` | black | page |
| `--surface` | white | gray-02 `#1c1c1c` | gray-01 `#161616` | cards, panels |
| `--surface-2` / `--surface-3` | gray-02 / gray-03 | gray-03 / gray-05 | gray-02 / gray-04 | nested surfaces, segmented controls |
| `--text` | gray-12 `#171717` | gray-12 `#ededed` | gray-12 `#ededed` | body text |
| `--muted` | gray-11 `#6f6f6f` | gray-11 `#a0a0a0` | gray-11 `#a0a0a0` | secondary text, terminal `.t-dim` |
| `--subtle` | gray-09 | gray-09 | gray-08 | borders only, never text |
| `--border` | gray-06 | gray-06 | gray-04 | decorative separators |
| `--field` | gray-07 | gray-07 | gray-07 | chip, ghost button and key fills |
| `--input-border` | gray-10 `#858585` | gray-09 `#707070` | gray-09 `#707070` | control outlines |
| `--accent` | lilac-11 `#5746af` | lilac-11 `#9e8cfc` | amber-09 `#ffb224` | links, accent text; terminal commands |
| `--accent-strong` | lilac-09 `#6e56cf` | lilac-09 `#6e56cf` | amber-09 | primary button background, focus |
| `--accent-soft` | lilac-03 | lilac-03 | amber-03 | selected and secondary backgrounds |
| `--ok`, `--warn`, `--danger` | green-11, amber-11, red-11 | green-11, amber-11, red-11 | green-11, gold-09, red-11 | states, each with a `-soft` step-3 background |
| `--t-id` | — | — | navy-11 `#849dff` | addresses and identifiers in the terminal |

### Type, shape, motion

| Group | Tokens | Values |
|---|---|---|
| Families | `--font`, `--mono` | Inter (variable, the SDS font), then the platform UI fonts; Inconsolata (variable, the SDS monospace), then the platform monospace stack |
| Type scale | `--fs-3xs` … `--fs-2xl`, `--fs-lead`, `--fs-hero` | 11, 12, 13, 14 (SDS secondary), 16 (SDS primary), 18, 24 and 30 px; two `clamp()` sizes for the intro. Every `font-size` reads one (test) |
| Spacing scale | `--space-1` … `--space-8` | 4, 8, 12, 16, 24, 32, 48 and 64 px, the 4 px grid |
| Radius | `--radius`, `--radius-md`, `--radius-sm` | 20, 14 and 10 px; pills use 980 px |
| Shadow | `--shadow-sm`, `--shadow`, `--shadow-lg` | layered and faint in light; none or a hairline in dark |
| Focus | `--focus`, `--ring` | the accent, and a 4 px ring at 22 % (light) or 30 % (dark and terminal) |
| Easing | `--ease`, `--ease-out` | standard, and a long ease-out for entrances |
| Breakpoints | media queries | 1280, 760 and 420 px, all `max-width` |

Font sizes are tokens. The spacing scale is defined; the rules still write their own values and move onto it progressively (gap 4).

## Components

| Family | Classes | Notes |
|---|---|---|
| Layout | `.top`, `.nav`, `.wrap`, `.card`, `.tile`, `.foot` | translucent header that gains a hairline on scroll; cards rise in turn on first paint |
| Actions | `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-small`; `.chip` | primary is white on `--accent-strong` |
| Selection | `.tabs` / `.tab`, `.face-switch` / `.face-btn`, `.lang-btn` | segmented controls with a sliding indicator; flags drawn in SVG |
| Fields | `.input-unit`, `.input-small` | the unit sits inside the field; focus draws the accent border and the ring |
| Data | `.table` (rows become cards under 760 px), `.facts`, `.terms`, `.quote`, `.preview` | figures read from the chain, skeletons until the first read |
| Status | `.pill-ok`, `.pill-warn`, `.pill-danger`, `.tx-ok`, `.tx-error`, `.tx-unverified`, `.toast` | a write only one endpoint saw is amber (`.tx-unverified`) |
| Position | `.timeline`, `.position`, `.steps` | one timeline per repo, fed by the indexer's export |
| Terminal | `.term`, `.t-band`, `.t-cmd` / `.t-input`, `.t-panel`, `.t-ticket`, `.tt`, `.t-key` | command line focused through `.t-cmd:focus-within`; panels draw on their own, so one unreadable value leaves a note in that panel only |

## Accessibility

| Check | Result |
|---|---|
| Text contrast, every text token on its surfaces and on its `-soft` background, three palettes | all at or above 4.5:1, checked by `test/design.test.js` (lowest: `--muted` on `--surface-3` in light, 4.53:1) |
| Primary button label | 5.39:1 white on lilac-09 (both themes); terminal 11.65:1 black on amber-09 |
| Text field outline (`--input-border`) | 3.69:1 light, 3.44:1 dark, 3.65:1 terminal: meets the 3:1 for component boundaries |
| Focus | 11 `:focus-visible` rules; where an outline is removed, an accent border and the ring replace it; the terminal command line shows focus on its container |
| Reduced motion, forced colours | both handled: motion stops, and Windows contrast themes keep an outline on focused fields |

## Gaps, by priority

1. **Outline contrast of chips, ghost buttons, step marks and terminal keys.** Fixed on 22 October 2026: they are drawn with `--input-border` (3:1 or more in every palette, the terminal face defining its own), and `test/design.test.js` checks it from the stylesheet.
2. **Touch targets under 44 px.** Fixed on 22 October 2026: one `@media (pointer: coarse)` block raises `.face-btn`, `.lang-btn`, `.tab`, `.chip`, `.btn-small`, `.input-small input` and `.t-key` to 44 px; the same test checks it.
3. **Type scale.** Fixed on 24 October 2026: the 26 distinct sizes map onto ten tokens (the SDS 14 and 16 px among them), checked by the design test.
4. **Spacing scale.** The tokens `--space-1` to `--space-8` exist (24 October 2026); the rules still carry 29 distinct values, 13 of them off the 4 px grid. Fix: map each rule onto the nearest step; values of 2 and 6 px stay allowed inside dense terminal rows.
5. **Colours outside the tokens.** The literals left in rules (the gradient stops, the terminal keys, scrollbars, glows) were taken from the SDS scales by hand; the tests check the tokens only. Moving them onto tokens is maintenance.

None of these changes the behaviour of the page; gaps 1 and 2 were accessibility and are closed, 3 to 5 are maintenance. A change to the stylesheet runs `npm test` and `npm run build` in `web/` like any other.
