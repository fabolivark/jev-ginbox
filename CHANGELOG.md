# Changelog

Every version of Jev Inbox for Gmail, newest first. The version in `package.json` and `manifest.json` is the one listed here, and each released version is tagged `v<version>`.

## Unreleased

- `npm run package` builds a clean `dist/` and writes `release/jev-inbox-<version>.zip`, and fails when `package.json` and `manifest.json` carry different versions. CI builds the zip on every push and pull request.
- `dist/` holds only the extension. The demo and the store stub build to `dev-dist/` and read their version from `manifest.json`.

## 0.1.0

First version.

- Shows Gmail's unread rows at the top of the visible list on the inbox, the other inbox tabs, search results, and labels and other folders, each switchable in the popup, without changing Gmail's own DOM order.
- Classifies unread rows with TypeSafe Jev on Vercel AI Gateway or on TypeSafe's own API: critical rows first, sorted by urgency, with chips for the user's own labels above a sensitivity threshold.
- A status bar above the list shows the unread count, in-flight progress and errors.
- Classification waits for the first-run privacy notice in the popup. API keys stay in `chrome.storage.local`, restricted to trusted extension contexts, and only the service worker reads them.
