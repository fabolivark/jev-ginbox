# jev-inbox

Chrome MV3 extension, Jev Inbox for Gmail. It shows Gmail's own unread rows at the top of the visible message list on the inbox, other inbox tabs, search results, and labels and other folders, each switchable in the popup, without changing the order of those rows in Gmail's own DOM. Critical rows come first, every classified unread row carries the label chips whose probability clears the sensitivity threshold, and a thin status bar above the list shows the unread count, in-flight progress, and errors. Unread rows are classified by TypeSafe Jev with the `ai` SDK's `experimental_evaluate`, on Vercel AI Gateway (`createGateway`, `typesafe-ai/jev`) or on TypeSafe's own API (`createTypeSafeAi`, `jev-latest`), chosen in the popup. Classification waits for `privacyAck`, the first-run notice in the popup. Low-ceremony code by design.

This file is the entry point for agents. Every doc describes the current state of the repo, never its history. The rules in ~/.codex/AGENTS.md apply on top of this file.

## Read next

- `docs/README.md`
- `README.md` and `PRIVACY.md`, the two files a stranger reads first

## Working here

Stack: TypeScript, esbuild, Chrome MV3.

Commands:

- `npm run build`: bundles `src/`, `dev/demo.ts`, and `dev/store/stub.ts` to `dist/` (esbuild) and copies `manifest.json`, `popup.html`, `section.css`, and `assets/`.
- `npm run watch`: same build, rebuilds on change.
- `npm run typecheck`: `tsc --noEmit` on `src/`, then on `src/` and `tests/` with `tsconfig.test.json`.
- `npm test`: bundles `tests/*.test.ts` into the gitignored `.test-dist/` and runs them with `node --test`.
- `npm run e2e`: builds, loads `dist/` into Playwright's Chromium, serves the `dev/demo.html` markup at `https://mail.google.com`, seeds settings and cache through the service worker, checks that rows are ordered and chipped with no provider call, that the content script cannot read storage, and that the worker refuses `test` from Gmail and an oversized batch, clicks a row chip and the bar buttons and checks the filtered rows, keyboard activation, that no chip event reaches Gmail's listeners, that the filter survives a re-render, a cache change and Compose and clears on another list, screenshots the filtered list at 1440, 768, 390 and 320 in light and dark, checks that the first-run notice says the snippet is body text and that the Gateway forwards to TypeSafe, then screenshots the popup in the notice and ready states at 1440, 768, 390 and 320 in light and dark into the gitignored `e2e-results/`. CI (`.github/workflows/ci.yml`) runs typecheck, test, build and e2e.
- `npm run store-images`: runs the build, then `scripts/store-images.mjs`, which renders the popup states, the five Gmail-window screenshots and the two promo tiles into `docs/store/`.

File map:

- `src/background.ts`: service worker. Restricts `chrome.storage.local` to trusted extension contexts (`setAccessLevel` `TRUSTED_CONTEXTS`), so the content script cannot read storage. Accepts `classify` and `state` only from the extension's own content script on `https://mail.google.com`, `test` only from the popup, and rejects a `classify` batch over 20 rows or 15 labels. Answers `state` with the content settings and the `crit:` cache entries of the current version, never a key or hint, and forwards each storage change the content script needs to the open Gmail tabs as a `changed` message, reporting a key change as a bare `keysChanged` flag. Handles `classify` and `test` messages, returns `needs_ack` for both until the popup stores `privacyAck`, resolves the provider and the matching key, caches classifications in `chrome.storage.local` under a key that includes the provider and the labels hash with a `ts` stamp, fans out to the chosen provider, reports per-row failures with the HTTP status, keeps a good classification when a cache write fails, and prunes the cache to 4000 entries once it passes 5000.
- `src/content.ts`: content script. Never touches `chrome.storage`: it loads settings and the cache with a `state` message to the service worker and follows changes through the worker's `changed` messages. Parses the current view from the hash, watches the visible list DOM and its rows' class changes, moves each row to its target layout slot with an inline `translateY` that composes with Gmail's own inline `transform`, critical rows first, synchronously in the observer callback before the next paint, from the classifications it keeps in memory, leaving Gmail's DOM order and every row's position in it untouched, extracts and dispatches the unread rows that still need classification, writes label chips and loading dots inside the rows, makes each chip and the Critical badge a filter button that, with the matching buttons in the bar, shows only the loaded rows that carry it (non-matching rows are ranked last and marked `data-gc-hidden`), stops every pointer and Enter or Space event on those buttons at window capture so none reaches Gmail, keeps the filter across re-renders and Compose and clears it on another list, renders the status bar with its progress line, halts on `needs_ack`, auth failures, or a missing key until the popup fixes it, animates a row that moves after a classification arrives with a transition between its old and new offset, restores each row's own inline styles, re-measures the offsets when a row changes height, backs off failed rows through a map that outlives the rows, and restores the list when the route or the list changes.
- `src/filter.ts`: the row filter: `RowFilter` and its `data-gc-filter` token, `isCritical` and `shownLabels`, the predicate that decides both which chips a row shows and whether it matches a filter, `filterOptions` for the bar, `filterRoute` (the route without the open thread or the query), and `filterNote`, the bar text that says the filter covers loaded rows only.
- `src/jev.ts`: `classifyEmail` and `testConnection`. Both build and run one Jev evaluation call on the chosen provider: critical, urgency, and one boolean question per label for a row, one boolean question on a fixed dummy state for the popup's connection check.
- `src/shared.ts`: shared types, `Provider`, settings defaults and key lists, label config, validators, `labelsHash`, `cacheVersion`, `threadKey`, `routeKey`, view and hash parsing, and `contentState` and `contentChanges`, which pick what the service worker hands the content script.
- `src/requests.ts`: `parseRequest`, the service worker's sender check and message validation.
- `tests/`: unit tests, bundled with esbuild and run with `node --test` by `npm test`.
- `src/popup.ts`: popup logic. Saves the provider, each provider's key plus a `...Hint` of its last four characters, enabled, sensitivity, the first-run acknowledgement, the Show on view toggles, and the label list; never reads a stored key back, showing "Key saved, ends in ..." with Replace and Remove instead; runs the connection test, disabled until the notice is accepted; clears the classification cache.
- `src/popup.html`: popup markup and its inline styles and theme tokens, including the labels editor.
- `src/section.css`: styles for the status bar, its filter buttons, the Critical badge, the inline label chips with their pressed and focus states, and the `data-gc-hidden` rows, all following Gmail's current theme.
- `assets/icon.svg`: icon source. `assets/icon-{16,32,48,128}.png` are rendered from it and copied into `dist/assets` by the build.
- `dev/demo.html` and `dev/demo.ts`: Gmail-like demo list with made-up mail, a stubbed `chrome` API, and canned classifications. Build first, then open the file. `?theme=dark` for the dark list, `?ack=0` for a browser that has not accepted the notice. `fixtures/` stays gitignored.
- `dev/store/`: sources for the Chrome Web Store images. `scene.html` is the Gmail-like Chrome window, driven by a `scene` query param (`hero`, `labels`, `dark`, `privacy`, `search`) and `nocallout=1` for the clean hero render, with the list authored inline from the same made-up mail as `dev/demo.html`. `promo.html` is the small and marquee promo tile, driven by `size`. `stub.ts` stubs `chrome.storage` and `chrome.runtime` with a state decoded from a `state` query param, the same technique as `dev/demo.ts`, so the real `dist/popup.html` and `popup.js` render the popup scenarios. `scripts/store-images.mjs` injects `stub.js` into a copy of `dist/popup.html`, screenshots the popup states, the five scenes and the clean hero with headless Chrome, and downsizes the 2x renders into `docs/store/`; intermediates land in the gitignored `dev/store/raw/`. Run it with `npm run store-images`.

All work ends on `main` with a commit. No push, no PR, no release without Omid.
Thinking, strategy, and decisions live outside this repo.

## Build and load

1. `npm install`
2. `npm run build`: bundles to `dist/` (esbuild) and copies `manifest.json`, `popup.html`, `section.css`, `assets/`. `npm run watch` rebuilds on change.
3. Chrome: chrome://extensions, enable Developer mode, "Load unpacked", select the `dist/` folder.
4. Open the extension popup, accept the first-run notice, pick the provider under "Connection", paste its API key, leave the switch on, pick the views under "Show on", add labels if wanted. Gmail: mail.google.com shows the unread rows of the visible list at the top, in place, and shows the status bar on the enabled views.

`npx tsc --noEmit` typechecks. Calls go to `https://ai-gateway.vercel.sh/v4/ai` or `https://api.typesafe.ai/v1`; both keys live in `chrome.storage.local`, which the service worker restricts to trusted extension contexts, and only the service worker reads them. The content script gets the named settings and the `crit:` cache entries from the worker's `state` reply and its `changed` messages.
