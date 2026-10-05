# cua_repl playbook (distilled from Codex rollouts)

Source: about 8,300 `cua_repl` calls (`js` plus 13 `js_reset`) across 33 Codex sessions and 378 task turns, together with
the Computer Use guidance and browser docs that the server sends back to the model. Most of the
traffic was QA of local web apps in the in-app browser (`iab`). Native-app use was rarer
(a file manager, a canvas-heavy 3D editor, a few desktop apps). Every example below is generic.

The server exposes one tool, `js`, which runs JavaScript in a **persistent** Node REPL with the
`cua`, `agent`, and `nodeRepl` globals. It also exposes `js_reset`, which wipes the REPL.

---

## 1. Opening a task

**First call of a turn (observed distribution):** `cua.createBrowserTab(...)` in 41% of turns.
`cua.rewriteDocumentation()` came first in 22% (always right after a context compaction or a new
task). `cua.getBrowser(...)` was first in 8%, `cua.getState()` in 6%, and `cua.getApp(...)` /
`cua.getTab(...)` in about 2% each. The rest reused a tab handle from an earlier turn.

Rules:
- **Open with a binding call and nothing else.** `createBrowserTab`, `getTab`, and `getApp` print
  the initial AX tree on their own. Don't follow them with `getAXState()` in the same call, because
  you would get the tree twice.
  ```js
  let tab = await cua.createBrowserTab("iab", "http://127.0.0.1:5173/", { visible: false });
  ```
- The first `cua` call of a session also prints the full Computer Use guide, and the first tab
  prints the browser guide ("Other Browser APIs", the safety policy, and the API reference). Read
  both once.
- **After context compaction, run `await cua.rewriteDocumentation();` (no args, no output of its own).**
  It reprints the full guide and browser docs. Codex did this 209 times, nearly always as the first
  call after a `compacted` event. Do it before you reuse handles from memory.
- **Discovery:** use `await cua.getState()` (apps plus browsers plus tabs) only when you don't know which
  browser or app to target. Use `cua.listApps({emit:false})` with a filter when you only need one bundle id:
  ```js
  nodeRepl.write((await cua.listApps({ emit: false })).filter(a => a.displayName?.includes("Example")));
  ```
- **Browser choice:** `"iab"` (in-app browser) is the default. You can address a browser by
  id (`'1'`, `'2'`, `'3'`), and Codex used the numeric id as soon as it was known.
  `createBrowserTab("chrome", ...)` failed with `Browser is not available: chrome`. Pick an id from
  `cua.getState()` / `cua.listBrowsers()` instead of guessing a family name.
  `cua.getBrowser({ id })` or `cua.getBrowser({ url })` selects a browser without opening a tab
  (useful for `capabilities`).
- **Keep tabs hidden:** pass `{visible:false}` (about 90% of tab creations). Use `visible:true` only when the
  user wants to watch. For extension browsers, pass `{sessionName: "🔎 Short task name"}`.
- **Native app on macOS:** call `cua.getApp("Example App")` with a display name, a bundle id
  (`"com.example.app"`), or a full `.app` path. It launches the app in the background if needed.
  If name resolution fails or times out, retry once with the bundle id from `listApps`.
- **Binding persists across turns.** Declare stable handles once and reuse them. Codex used `var`
  (633) and `let` (618) about equally. Use `var` or bare reassignment for anything you might
  redeclare in a later call, because a second `let x` in the same REPL throws. Reacquire a handle
  only when it is stale, after `js_reset`, or after an `X is not defined` error.

## 2. The observe→act loop and batching

The core loop is **one tool call = [0..N deterministic actions] + exactly one observation at the end.**

- 99.5% of calls that acted also observed in the same call. Codex almost never sent an action
  without a trailing `getAXState()` / screenshot.
- Actions per call: 0 → 44% (pure observation or reads), 1 → 33%, 2 → 12%, 3 → 6%, 4+ → 5%.
  About 42% of action-bearing calls were batched (2 or more actions).
- Batch only steps whose targets you already know: one form's fields, a fixed key sequence,
  open-menu-then-pick when the item is a stable Playwright locator. **Don't batch past a step
  whose result decides the next target**, such as a page navigation that invalidates indices.
- Median code length was 120 chars (p90 470). Keep calls short.
- Median wall time per call was 1.3 s (p90 6.5 s). Observations wait internally for the UI to
  settle, so **never add `setTimeout`/sleep before observing.** Use `waitFor` (Playwright) only
  for a specific async condition.

**Observation choice (share of calls):** `getAXState()` 57%, `getScreenshot()` 18%,
`getAXStateAndScreenshot()` 13%, Playwright `domSnapshot()` 8%, `tab.screenshot()` 14% (mostly
written to disk as evidence).
- The default `getAXState()` returns a **diff** against the previous tree. 2,523 outputs were
  diffs and 334 were "There has been no change in the accessibility tree." Diff format:
  `Removed element IDs: 42-171`, then lines prefixed `~` (changed) or `+` (added), then
  `The focused UI element is …`.
- Use `{disableDiffing:true}` (2.5% of calls) only after a screenshot-only observation, after an
  error, or when you need indices for elements the diff doesn't show.
- If an observation says "no change", **don't repeat the same bare observation.** Act differently,
  or take a screenshot if the change is visual (canvas, WebGL, styling). Codex followed a no-change
  result with an identical bare `getAXState()` only 6 times.
- Use screenshots for canvases, games, 3D views, layout or visual QA, and any app whose AX tree is
  just a window shell.

### Templates

```js
// A. act + observe (most common shape)
await tab.click(42); await tab.getAXState();

// B. fill a small form in one call, then observe once
await tab.setValue(12, "Example name");
await tab.setValue(14, "example@example.com");
await tab.click(18);
await tab.getAXState();

// C. resolve fresh indices *inside* the call (no extra round trip)
var s = await tab.getAXState({ emit: false, disableDiffing: true });
await tab.click(Number(s.match(/(\d+) button \(collapsed\) Choose action/)[1]));
s = await tab.getAXState({ emit: false, disableDiffing: true });
await tab.click(Number(s.match(/(\d+) button Confirm choice/)[1]));
await tab.getAXState();

// D. repetitive web task with stable locators (Playwright) + one observation
const pw = tab.playwright;
await pw.getByRole("button", { name: "Open menu", exact: true }).click();
await pw.getByRole("tab", { name: "Settings", exact: true }).click();
await pw.getByLabel("Display name", { exact: true }).fill("Example");
await tab.getAXState();

// E. quiet extraction: emit:false + write only what you need
nodeRepl.write(await pw.locator("#status").innerText());
nodeRepl.write((await tab.getAXState({ emit: false })).slice(0, 4000));

// F. evidence capture without flooding context
var fs = await import("node:fs/promises");
await fs.writeFile("/tmp/example/step-1.jpg", await tab.getScreenshot({ emit: false }));
```

**Token-saving habits seen:** `{emit:false}` on 10% of calls (on observations that feed regexes,
file writes, or loops). `nodeRepl.write` of a narrow slice (`innerText`, `textContent`, a filtered
`dev.logs`, `.slice(0, N)` of AX text). `nodeRepl.emitImage(await x.getScreenshot({emit:false}))`
when an image must be shown after other processing. Never `nodeRepl.write` an auto-emitting
call's result without `emit:false`, or you get the output twice.

## 3. Native apps

- Bind with `var app = await cua.getApp("Example App")`. The result shows
  `Window: "<title>", App: <name>` plus the tree. Elements look like
  `7 button Save, ID: saveBtn, Secondary Actions: Raise` or `46 text field (settable) Name`.
- **Index first:** `app.click(7)`, `app.setValue(11, "text")`, then `app.pressKey("Return")`.
  `performSecondaryAction(idx, "Expand")` is only for actions listed under `Secondary Actions:`
  (Codex used it once: "Raise" on a window). Don't guess action names.
- **Canvas-heavy and custom-drawn apps** (3D editors, games, some Electron or GL apps) expose only
  the window chrome. Every observation returns "no change", so work by **screenshot plus
  coordinates**:
  ```js
  await app.getScreenshot();                        // look first
  await app.click([380, 350]); await app.pressKey("shift+F4");
  await app.getAXStateAndScreenshot();              // verify visually
  ```
  Coordinates are window-relative and measured on the latest screenshot of *that* target. Re-take a
  screenshot whenever the layout may have moved. Codex batched long hotkey and click chains here
  (5–8 steps) because each step was deterministic, then checked them with one screenshot.
- **Keyboard-driven navigation is the reliable path in native apps.** For example, a file manager's
  go-to-folder shortcut: `pressKey("super+shift+g")`, `typeText(path)`, `pressKey("Return")`, then
  `getAXState()`. In an app's command search, use `pressKey("F3")` (or the app's equivalent),
  `typeText("Save As")`, `pressKey("Return")`.
- Path fields in custom-drawn dialogs: double-click the field (`click([x,y],{clickCount:2})`), select
  all (`ctrl+a`/`super+a`), then `typeText(path)` and `Return`. `paste()` timed out in one such
  app with `Timed out waiting for the application to read the clipboard`. Fall back to `typeText`.
- `getApp` on the host agent's own app is refused:
  `Computer Use is not allowed to use the app '<host bundle id>' for safety reasons.` (or "rejected
  due to unacceptable risk"). Don't retry. Codex wasted 8+ calls across sessions repeating this.
- `Computer Use was not approved to use <App>` means the user declined, or hasn't granted, access.
  Stop and ask the user. Don't loop.
- `The Mac is locked and automatic unlock could not unlock it.` means you should stop and ask the user to unlock.
- Quit an app with `app.pressKey("super+q")` only if you launched it or the user asked you to.
- Linux and Windows differences, from the guide: bind by `{windowId}` taken from `cua.listWindows()`, and
  launch apps with `cua.computer.launch_app({app})`. `setValue` is unavailable on Linux, and `selectText`
  on Linux and Windows. On Windows, scroll needs a coordinate target plus `{pixels:N}`. Take a fresh
  screenshot before coordinate input on Windows.

## 4. Browser tabs

- **Three ways to drive a tab, in Codex's order of use:** Playwright locators (25% of all calls
  clicked through `tab.playwright`), AX element indices (18%), and coordinates (6%).
  - Use AX indices for short, one-off tasks where the index is in the tree you just read.
  - Use Playwright for repeated flows, apps you are developing (known roles, labels, and ids),
    and anything you want to batch without re-reading indices. Always pass `{exact:true}` for names.
  - Use coordinates for canvas or WebGL content. Get them from the DOM rather than by eye:
    ```js
    var r = await pw.locator(".marker").filter({ hasText: "Example" })
      .evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; });
    await tab.click([r.x, r.y]); await tab.getAXState();
    ```
- The `cua` tab object has `.playwright`, `.dev`, `.capabilities`, `.clipboard`, and `.content` directly.
  The equivalent `agent.browsers.get(id)` → `browser.tabs.get(tab.id)` route also works.
- Navigation: `tab.goto(url)`, `tab.reload()` (needed after code changes when there's no HMR), and
  `tab.back()` / `tab.forward()`. **Don't `goto` the URL the tab is already on**, because that reloads it
  and can lose input. Use `reload()` when you mean to reload.
- Reads: `pw.locator(sel).innerText()` / `textContent()`, `allTextContents()`,
  `pw.evaluate(() => …)` (read-only DOM scope; some globals such as `parseFloat` were missing in
  that scope, so use `Number(...)`), and `pw.domSnapshot()` when you need ground truth for selectors.
- Debugging: `nodeRepl.write(await tab.dev.logs({ levels: ["warn","error"], limit: 20 }))`. Codex did this
  in about 5% of calls and in many final checks.
- Capabilities: `(await browser.capabilities.get("viewport")).set({width, height})` for responsive
  checks, and **always `reset()` before finishing** (101 turns ended with a reset).
  `"visibility"` `.set(true)` shows the browser to the user.
- WebMCP: if output contains "Browser notifications: WebMCP tools are available in tab N", you
  can `const t = await (await tab.capabilities.get("webmcp")).fetchTools(); await t.call("name", {})`.
  Notifications also say when the tools disappear. Apply the confirmation policy to any side-effecting tool.
- Dialogs: `await tab.getJsDialog()` returns an alert, confirm, or prompt, which you then `.accept()` or `.dismiss()`.
- Tab lifecycle: agent-created tabs close at turn end. Use `tab.markDeliverable()` to keep a
  user-facing result page and `tab.markHandoff()` to continue in a later turn. Re-mark them each turn.
  Close scratch and reference tabs with `tab.close()` (217 of 378 turns ended with a close).
- Lookup tasks: one focused direct URL or one search query, then verify on the page. Don't loop over
  guessed URL variants.

## 5. Text entry and keys

| Need | Native app | Browser tab |
|---|---|---|
| Replace a field's value | `setValue(idx, "v")` | `setValue(idx, "v")` or `pw.getByLabel(..).fill("v")` (fill: 182 uses) |
| Type at the focus | `typeText("v")` | `typeText(null, "v")` (or `typeText(idx, "v")` to focus first) |
| Key / chord | `pressKey("Return")` | `pressKey(null, "Escape")` / `pressKey(idx, "Tab")` |
| Long or multiline / formatted | `paste(text, {format:"text"})` (restores clipboard) | `paste(idx\|null, text, {format})` (does not restore) |
| Char-by-char (game input, key repeat) | n/a | `pw.getByLabel(..).pressSequentially("www", {delay:150})` |
| Native `<select>` | n/a | `pw.getByLabel("Example").selectOption({label:"Option"})` |

- Key syntax is xdotool-style: `Return`, `Escape`, `Tab`, `space`, `BackSpace`, `Up`/`Down`/`Left`/`Right`,
  `Home`, `F2`/`F3`/`F11`, `KP_1`…`KP_9`, `KP_Add`/`KP_Subtract`/`KP_Decimal` (numpad), plus chords like
  `super+a`, `super+shift+g`, `ctrl+a`, `shift+alt+z`, and `alt+a`. Most used: Escape (147), Return (145), Tab (87).
- Use `Escape` to close menus and popovers before the next action. It was the most common key overall.
- Browser native-input wrappers throw on DOM-only tabs (MCP app tabs), so use Playwright there.

## 6. Scrolling, dragging, and canvas

- `scroll(target, dir, pages)`. Codex nearly always used a **coordinate** target inside the
  scrollable region: `tab.scroll([640, 480], "down", 1)`. Fractional pages are fine (`0.8`). An index
  target works for a specific scroll area: `scroll(42, "down", 1)`. On Windows use `{pixels:500}`.
- Scrolling was rare (58 calls) because AX trees already list off-screen elements and you can click
  them by index without scrolling. Scroll only for lazy-loaded or virtualized content, or to see
  something visually.
- `drag([x1,y1],[x2,y2])` was used 203 times for camera pans, sliders, and canvas gestures. To move a
  long distance, chain short drags in a loop and take one screenshot at the end:
  `for (let i=0;i<5;i++) await tab.drag([104,839],[104,790]); await tab.getAXStateAndScreenshot();`
- Click options: `click([x,y], {clickCount: 2})` for a double-click, `{mouseButton: "right"}` for a
  context menu. The guide says Linux element clicks support only a single left or right click.
- The click target must be a number or `[x, y]`. Objects like `{x,y}`, `{target:n}`, or
  `{elementIndex:n}` fail with `Accessibility action requires an element index or point`.

## 7. Error → recovery

Overall, 379 of 8,324 calls failed (4.6%). 306 errors were isolated, 23 came in pairs, and only 8
streaks were 3–4 long. **Actions earlier in a batched call have already happened when a later
step throws**, so re-observe before you retry anything.

| Error (exact or prefix) | Meaning | Fix |
|---|---|---|
| `Accessibility element N belongs to a previous page` | Navigation invalidated indices | `getAXState({disableDiffing:true})` → re-derive the index |
| `Accessibility element N is stale or missing` / `No node with given id found` / `Node does not have a layout object` / `Could not check the click target's shadow root` | Index stale or element hidden | Fresh full tree; use a Playwright locator or the element's center coordinates |
| `Computer Use server error -10005: The element ID is no longer valid…` | Native index stale | `getAXState()` and retry with the new index |
| `Error: … strict mode violation: getByText(...) resolved to N elements` | Locator ambiguous | Scope it: `pw.locator("#panel").getByText(..., {exact:true})`, or `.first()` / `.nth(i)` |
| `Error: Playwright selector deadline exceeded … waiting on click for selector …` | Element absent, disabled, or covered | Observe (`getAXStateAndScreenshot`); close the blocking overlay with `Escape`; check names; don't blind-retry |
| `locator.waitFor(visible) timed out …` | Expected state never arrived | Screenshot and logs (`dev.logs`), then reconsider the expectation |
| `Error: Cannot interact with a disabled element` | Precondition unmet | Read the state; satisfy the precondition first |
| `Timed out running CDP command "Emulation.setFocusEmulationEnabled" for tab N` | Tab renderer hung (heavy page) | Read `agent.documentation.get("browser-troubleshooting")` once, then **create a fresh tab** in the same browser |
| `Blocked browser navigation by Browser Use URL policy: data:text/html…` | Tab sits on an error page (the dev server was down) and reload hits the policy | Restart or check the server, then `createBrowserTab` with the real URL. Don't `reload()` the error page |
| `Browser Use cannot open <url> … net::ERR_CONNECTION_REFUSED` | Local server not running | Start the server (shell), then retry once |
| `net::ERR_BLOCKED_BY_CLIENT` | Blocked by an extension or policy | Use another source; don't retry |
| `Browser Use rejected this action due to browser security policy. Reason: Auto-review denied…` / `URL policy blocks this action` (e.g. `file://`) | Policy denial | Don't retry the same URL; serve the file over a local http server or ask the user |
| `Tab not found in browser N.` / `Tab N is not part of browser session …` | Tab closed at turn end or in another session | `cua.listTabs()` or `cua.getState()`; reuse a listed tab or create a fresh one. **Keep the browser binding** |
| `Browser is not available: chrome` / `: iab` / `: 2` | Wrong browser id or family | `cua.getState()` → use a listed id |
| `js execution timed out; kernel reset, rerun your request` | Call hung (often `getBrowser({url})` on a slow site); REPL wiped | Reacquire handles, then rerun a smaller step |
| `X is not defined` / `x.getState is not a function` | Lost handle after reset, or invented method | Rebind (`getTab`/`getApp`). Only `cua.getState()` exists; tabs have `getAXState()` |
| `browser.tabs.close is not a function` | Invented API | Call `tab.close()` on the tab object |
| `Computer Use is not allowed to use the app '<host>' …` | Host app is off-limits | Never retry |
| `Computer Use was not approved to use <App>` | Access denied | Ask the user |
| `The Mac is locked …` | Screen locked | Ask the user to unlock; stop |
| `Timed out waiting for the application to read the clipboard` | `paste` unsupported in that app | `typeText` instead |

**`js_reset`** (13 uses) was mostly end-of-task cleanup, plus recovery after a wedged call. After a
reset, every handle is gone: rebind with `cua.getTab(id, {browser})` or `cua.getApp(...)`.

## 8. Verification and finishing

- "Attempting an action is not completion." Finish only when the returned state **visibly shows
  the result**: the target text or element is in the AX diff, a value reads back through
  `innerText`, the selected or checked state is set, or a screenshot shows it. Once there is one
  authoritative signal (a toast, selected option, URL param, or line item), stop. Don't keep re-verifying.
- Codex's last three calls of a turn contained: a screenshot (77% of turns), `getAXState` (63%),
  a tab close (60%), file writes of evidence (56%), `dev.logs` error check (42%), a viewport reset
  (29%), `emitImage` (24%), `markDeliverable` (18%), `markHandoff` (7%).
- **Finishing checklist:** verify, then check the console for errors on dev tasks, reset any
  viewport override, `markDeliverable()` the page the user should see, close reference and scratch
  tabs, and include screenshots inline in the final answer if the user asked for them or it's web-dev QA.
- Typical calls per task turn: median 11, mean 22, p75 21, p90 40. Long QA sweeps reached
  hundreds of calls, and those leaned on Playwright loops to stay efficient.

## 9. Anti-patterns observed (avoid)

1. **Retrying a forbidden or denied target.** `getApp` on the host agent app, policy-denied URLs, and
   `Browser is not available: chrome` were each retried several times across sessions.
2. **Inventing API methods**, such as `tab.getState()`, `browser.tabs.close(id)`, and
   `click({target:n})` / `click({x,y})`. Use only methods from the printed API or the browser docs.
3. **Reloading a tab stuck on a `data:` error page.** Every reload is policy-blocked. Open a new tab instead.
4. **Redundant output:** `nodeRepl.write(await tab.getAXState())` (double output),
   `nodeRepl.write(app)` (dumps the method list), or both a full tree and a screenshot when one would do.
5. **Identical consecutive calls** happened 64 times, mostly re-observing after "no change" or
   retrying a failed locator unchanged. Change something (scope, wait condition, method) before retrying.
6. **Batching past a navigation** and then clicking old indices → "belongs to a previous page".
7. **Broad Playwright text locators** (`getByText("Close")`) → strict-mode violations. Use role+name+exact, scoped to a container.
8. **Long `waitFor` timeouts** (20–30 s) on states that never arrive cost a lot of wall time. Use short timeouts, then observe.
9. **Driving canvas apps through the AX tree.** It returns "no change" forever, so switch to screenshots and coordinates immediately.
10. **Heavy loops of 40–110 iterations** each calling `getAXState({emit:false})`. These work, but
    they are slow and fragile. Prefer reading one DOM signal (`locator.waitFor`, `textContent`) per iteration.

## 10. Stats summary

| Metric | Value |
|---|---|
| cua_repl calls analysed | 8,324 (8,311 `js`, 13 `js_reset`) |
| Task turns | 378; calls/turn median 11, mean 22, p90 40 |
| Failure rate | 4.6%; 81% of errors isolated (recovered on the next call) |
| Calls with ≥1 action | 56%; of those, 42% batched ≥2 actions; 99.5% observed in the same call |
| Observation mix | getAXState 57%, getScreenshot 18%, AX+screenshot 13%, domSnapshot 8% |
| Diff vs full | 2,523 diff outputs, 334 "no change", 211 explicit `disableDiffing` |
| Targeting | Playwright locator clicks 2,067 calls; AX index clicks 1,496; coordinate clicks 485 |
| Text entry | fill 182, typeText 109, setValue 80, paste 3 |
| `emit:false` | 10% of calls |
| Wall time | median 1.3 s, p90 6.5 s per call |
| `rewriteDocumentation` | 209 calls, after compaction or at the start of a new task |
