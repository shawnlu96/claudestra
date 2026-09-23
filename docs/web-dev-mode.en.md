# Web developer mode · the visual temporary-tuning workflow

[简体中文](./web-dev-mode.md) · **English**

> Audience: every agent and person adjusting UI / interaction / performance under `web/`.
> One-line rule: **whenever the job is "change a value and see how it looks", expose the value on the developer panel and let the user drag it, then hard-code the final value.** Do not loop "change → build → user looks → another message → change again".

## Why

Before 2026-09-22 every UI tweak and every on-device investigation in the web client was conversation-driven: the agent guessed a value, the user built and looked, described the feel, the agent guessed again. A spacing change took three to five round trips, and every PWA container issue meant hand-writing a throwaway diagnostic overlay and deleting it afterwards (container rule 6 in `web/CLAUDE.md`). Developer mode turns both into permanent infrastructure:

- **visual tuning**: parameters become sliders / toggles / colour pickers on the panel; the user drags on the phone until it looks right and pastes the values back;
- **resident readouts**: FPS, frame gap, commit bursts, DOM count, measured viewport values and an event list, no more hand-written overlays;
- **zero cost for normal users**: the panel is loaded with `next/dynamic`; when the switch is off it is not in the bundle.

## How to turn it on

| Entry | Notes |
|---|---|
| Settings → Experimental → "Developer mode" | takes effect immediately, no reload |
| URL `?dev=1` / `?dev=0` | for automated screenshots and one-off enabling on someone else's phone; writes the same localStorage key `cstra_devmode` |
| Console `window.__cstraDev` | `setDevMode / devEvent / recentDevEvents / allCounters / registerDevSection` |

When on, a bottom-right badge `🛠 60fps · gap 17ms · burst 0` opens the panel; `html[data-dev]` is set at the same time.

## What the panel already has (don't rebuild it)

| Section | Contents |
|---|---|
| stats.js meters | FPS / MS / frame gap (the third is a custom panel; when the compositor stalls, rAF is late too) |
| Perf | max frame gap, input→next frame (pointerdown→double rAF by hand; Safari has no Event Timing API), long tasks (Safari: n/a), DOM node count, rendered messages (`[data-mid]`), bubble render rate, store produce rate, commit-burst count |
| Bench | "scroll to top" → "start scroll bench": rAF-stepped constant-speed scroll of the message list to the bottom (speed adjustable); "start sidebar bench": on wide screens, programmatically oscillates the sidebar width 240–480px for a few seconds (measures the content pane's full reflow); one result line lands in the event list: frame-gap p50 / p95 / max, frames >50ms / >100ms, DOM nodes, mounted bubbles, long tasks. Use it before and after any rendering change (`docs/design-render-perf.md`) |
| Store | activeAgent / agents / messages / streaming / syncState / streamDown / loadingHistory / bgTasks |
| Viewport | `navigator.standalone`, inner, visualViewport, measured safe-area `env()`, layoutMode, `data-streaming`, hash; toggles: bottom-alignment line (red line at `fixed bottom:0`), element outlines |
| Actions | clear events, reset counters, copy events to clipboard, reload, turn developer mode off |
| Recent events | dual-writes from the three resident probes (runtime errors / slide animation / React commit bursts) and `store.clientLog`, newest at the bottom |

## Workflow 1: visual tuning (UI / animation / thresholds)

**1. Collect the values under tuning into one object; the code reads the object, not constants.**

```ts
// features/chat/components/composer.tsx
const TUNE = { bottomPad: 12, slideMs: 300, followThreshold: 80 };
```

CSS values go through CSS variables: the code says `var(--cstra-composer-pad, 12px)`, the panel calls `document.documentElement.style.setProperty(...)`.

**2. Register a section with a dated, reasoned comment.** Registering at module top level is enough: a panel opened later replays existing registrations, and a new registration while the panel is open rebuilds it.

```ts
import { registerDevSection } from "@/features/devtools/dev-registry";
import type GUI from "lil-gui";

// dev-section: 2026-09-22 composer bottom padding / slide duration tuning (owner: too tight with the keyboard up); delete once settled
registerDevSection("composer-tune", ({ gui, onTick }) => {
  const f = (gui as GUI).addFolder("Composer");
  f.add(TUNE, "bottomPad", 0, 40, 1).onChange((v: number) =>
    document.documentElement.style.setProperty("--cstra-composer-pad", `${v}px`)
  );
  f.add(TUNE, "slideMs", 100, 800, 10);
  f.add(TUNE, "followThreshold", 0, 300, 10);
  // read-only readout: string controller + listen + disable, refreshed by onTick every second
  const r = { offset: "-" };
  f.add(r, "offset").listen().disable();
  onTick(() => { r.offset = `${Math.round(measureOffset())}px`; });
  return () => f.destroy();
});
```

**3. Let the user drag.** Tell them to open `?dev=1`, which section, which sliders. Two ways to get the final values back: the user reads the numbers out; or `devEvent("tune", JSON.stringify(TUNE))` in `onChange`, and the user presses "copy events" on the panel and pastes the block.

**4. Hard-code the result, delete everything.** Write the values back into constants / CSS, remove the `registerDevSection` call, the exposed `TUNE` object and the comment. `bun test` carries a guard (`tests/web-dev-sections.test.ts`): any `registerDevSection(` call outside `features/devtools` must have a `dev-section: YYYY-MM-DD` comment within the 3 lines above it, or the test fails. Its purpose is to make leftover temporary sections visible in CI, not to let you keep them forever by adding the comment.

## Workflow 2: diagnostic readouts (no tuning, just values)

When you need the live value of some internal state (scroll position, a ref, a timer state), register a section the same way with read-only controllers + `onTick`, or simply `devEvent("scroll", ...)` into the event list. **Do not hand-write a temporary `<div style="position:fixed">` overlay again** — that is exactly what this replaces.

Dual-write rule: `devEvent(kind, msg)` only goes to the panel's event ring (200 entries, accumulating even when the switch is off, negligible cost); to keep server-side evidence as well, use `postClientLog(msg)` (`lib/client-log.ts`, the frontend's single logging exit; it already dual-writes).

## Workflow 3: performance baseline (measure before touching rendering)

For any "it feels janky" change, take a baseline with the panel first and compare with the same metrics afterwards:

| Metric | What to look at |
|---|---|
| max frame gap | >100ms while scrolling / appending?; when the compositor stalls it speaks before FPS does |
| input→next frame | how long after a tap something paints (manual INP approximation) |
| bubble render rate | if every bubble re-renders during streaming, memo is broken |
| produce rate | store writes per second; read together with bubble render rate |
| commit bursts | non-zero means a synchronous commit chain (#185-class); the event list carries roots / hook indices |
| DOM nodes / rendered messages | the scale factor behind long-conversation jank |

## Constraints

- **Dev-only code lives in `web/features/devtools/`**, or touches product code through a single line: `devCount("x")` (counts only while on) / `if (isDevMode())`. No new debugging libraries; stats.js and lil-gui are already there.
- The big files (chat.tsx / chat-store.ts / message-list.tsx) are locked by the guard to only ever shrink: adding a touch point means saving the same number of lines elsewhere in that file; whatever an existing global signal already provides (`cstra:commit-burst` events, `__cstraProduceTrail`) should be read from there instead of adding a counter.
- The repo root's `scripts/guard` applies here too: new files ≤400 lines, functions ≤100 lines (useEffect callbacks count as functions), every `catch` says why losing the error is harmless. That is why the panel is split into dev-meters / dev-panel-sections / dev-overlay.
- The panel is portaled to `document.body`; never put any overlay inside the swipe transform container in `chat.tsx` (container rule 5b).
- No localStorage inside sections; tuning is one-off, the result goes into code.
- The built-in sections already mark what Safari lacks (`PerformanceObserver` long tasks, Event Timing) as n/a; feature-detect the same way when adding readouts so the panel never throws on iOS.
- `cd web && npm run build` as usual before shipping; the panel is neither visible nor loaded for normal users, but code inside `isDevMode()` branches still compiles, so keep it pure.

## Related files

```
web/features/devtools/
  dev-mode.ts       master switch (pure logic, bun-tested)
  dev-events.ts     event ring / counters / rate sampler
  dev-registry.ts   registerDevSection
  dev-mount.tsx     switch → dynamic load
  dev-meters.ts     stats.js meters / frame gap / input lag / long-task sampling hooks
  dev-panel-sections.ts the four built-in sections
  dev-overlay.tsx   panel shell: badge, lil-gui lifecycle, event list
tests/web-dev-mode.test.ts       switch resolution / event ring / counters / registry
tests/web-dev-sections.test.ts   temporary-section annotation guard
```
