# Open Window web: design system

What the interface is made of, visually: the tokens, the components, the rules they follow, and where they fall short. Everything lives in one stylesheet, `src/style.css`; this page describes it as of 22 October 2026 and is the reference for any change to it. Measured with a script over the stylesheet (contrast ratios computed from the token values, WCAG 2.2 formula), not by eye.

## Principles

Calm, legible, finance-grade. Clean surfaces and one accent; an energy gradient used sparingly; Inter for text and the system monospace for figures in the terminal. Motion is short and eased, and stops when the system asks for reduced motion. Two faces of one state: the **guided view** follows the system theme (light or dark); the **terminal view** is a dark market screen whatever the theme.

## Tokens

All colours, radii, shadows and easings are custom properties on `:root`, redefined for the dark theme (`prefers-color-scheme: dark`) and for the terminal face. 313 rules read them through `var(--…)`.

### Colour

| Token | Light | Dark | Terminal | Use |
|---|---|---|---|---|
| `--bg` | `#f5f5f7` | `#000000` | `#000000` | page |
| `--surface` | `#ffffff` | `#161617` | `#0f0f10` | cards, panels |
| `--surface-2` / `--surface-3` | `#f5f5f7` / `#e8e8ed` | `#1d1d1f` / `#2c2c2e` | `#18181a` / `#232326` | nested surfaces, segmented controls |
| `--text` | `#1d1d1f` | `#f5f5f7` | `#f5f5f7` | body text |
| `--muted` | `#636366` | `#a1a1a6` | `#8e8e93` | secondary text, terminal `.t-dim` |
| `--subtle` | `#86868b` | `#86868b` | `#636366` | borders only, never text |
| `--border` | `#e3e3e8` | `#2c2c2e` | `#232326` | decorative separators |
| `--field` | `#d2d2d7` | `#424245` | `#3a3a3c` | chip, ghost button and key outlines |
| `--input-border` | `#8e8e93` | `#6e6e73` | — | text field outlines |
| `--accent` | `#0066cc` | `#2997ff` | `#409cff` | links, accent text |
| `--accent-strong` | `#0071e3` | `#0071e3` | `#0a84ff` | primary button background, focus border |
| `--accent-soft` | `#e8f1fd` | `#0b2440` | `#0a2440` | selected and secondary backgrounds |
| `--ok`, `--warn`, `--danger` | `#1b7a38`, `#a35200`, `#c4161c` | `#30d158`, `#ffb340`, `#ff6961` | `#30d158`, `#ffd60a`, `#ff453a` | states, each with a `-soft` background |
| `--t-id` | — | — | `#64d2ff` | addresses and identifiers in the terminal |

### Type, shape, motion

| Group | Tokens | Values |
|---|---|---|
| Families | `--font`, `--mono` | Inter (variable), then the platform UI fonts; the platform monospace stack |
| Radius | `--radius`, `--radius-md`, `--radius-sm` | 20, 14 and 10 px; pills use 980 px |
| Shadow | `--shadow-sm`, `--shadow`, `--shadow-lg` | layered and faint in light; none or a hairline in dark |
| Focus | `--focus`, `--ring` | the accent, and a 4 px ring at 18 % (light) or 28 % (dark) |
| Easing | `--ease`, `--ease-out` | standard, and a long ease-out for entrances |
| Breakpoints | media queries | 1280, 760 and 420 px, all `max-width` |

Font sizes and spacing are not tokens yet: they are written in each rule (see the gaps below).

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
| Text contrast, every text token on its surfaces, three palettes | all at or above 4.5:1 (lowest: `--accent` on `--accent-soft`, 4.89:1 light; terminal `.t-dim`, 5.44:1 on its lightest surface) |
| Primary button label | 4.70:1 white on `--accent-strong` (both themes); terminal 5.76:1 black on `#0a84ff` |
| Text field outline (`--input-border`) | 3.26:1 light, 3.57:1 dark: meets the 3:1 for component boundaries |
| Focus | 11 `:focus-visible` rules; where an outline is removed, an accent border and the ring replace it; the terminal command line shows focus on its container |
| Reduced motion, forced colours | both handled: motion stops, and Windows contrast themes keep an outline on focused fields |

## Gaps, by priority

1. **Outline contrast of chips, ghost buttons, step marks and terminal keys.** They are drawn with `--field`, at 1.5:1 (light) and 1.8:1 (dark) against their surface, under the 3:1 that WCAG 2.2 (1.4.11) asks of a boundary that identifies a control. Fix: draw interactive outlines with `--input-border`, and keep `--field` for decoration.
2. **Touch targets under 44 px** on narrow screens: `.face-btn` 30, `.btn-small` and `.input-small` 32, `.chip` and `.t-key` 34, `.tab` 38. They pass the 24 px minimum of WCAG 2.2 (2.5.8) but not the 44 px of the platform guidelines. Fix: one `@media (pointer: coarse)` block raising them to 44 px.
3. **Type scale.** 26 distinct font sizes, mostly `rem` values two decimals apart (`0.84`, `0.88`, `0.9`, `0.92`, `0.95`) plus a few `px`. Fix: eight tokens on a 1.125 ratio (`--fs-xs` to `--fs-3xl`) and a `clamp()` for the hero, then map each rule onto the nearest step.
4. **Spacing scale.** 29 distinct values, 13 of them off a 4 px grid (5, 6, 7, 9, 10, 11, 13, 14, 18, 22, 26, 30 px). Fix: `--space-1` to `--space-8` on the 4 px grid; values of 2 and 6 px stay allowed inside dense terminal rows.
5. **Colours outside the tokens.** 40 hex values in rules, 23 distinct, mostly `#fff` and terminal greys. Fix: move them onto existing tokens or new terminal ones.

None of these changes the behaviour of the page; gaps 1 and 2 are accessibility, 3 to 5 are maintenance. A change to the stylesheet runs `npm test` and `npm run build` in `web/` like any other.
