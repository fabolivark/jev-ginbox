# Changelog

Every version of Jev Inbox for Gmail, newest first. The version in `package.json` and `manifest.json` is the one listed here, and each released version is tagged `v<version>`.

## Unreleased

- A fresh install opens the setup tab. The toolbar badge shows `!` until the notice is accepted and the selected provider has a key, and while its key is rejected (401 or 403). The Gmail bar offers Finish setup when classification halts for setup.
- The first-run notice is three short bullets with the same disclosures, and the popup dims its settings while the extension is paused.
- Provider failures show as plain text in the popup's Test result and the Gmail bar (rejected key, rate limited, unavailable, unreachable, refused with its status), never the provider's own message.
- Each complete label saves on its own; an incomplete one stays in the editor, marked invalid with an inline message.
- The armed Clear cache button reads "Confirm clear".
- "Sensitivity" is now "Strictness": higher shows only the emails and chips Jev is most sure about. The stored value is unchanged.
- The cache keeps the sender, subject and date of each classified thread, locally only. "Manage" in the popup opens a page that groups the classified threads by label and sender, with filters, and opens a Gmail search for the picked senders, split into numbered searches when long, to delete or archive a whole group in Gmail.
- The bar's "Select in Gmail" buttons tick Gmail's own checkbox on every loaded row with a label or the Critical badge, so Gmail's toolbar deletes or archives that category; the bar shows the selected count and a Clear selection button. The extension never deletes or moves mail itself.
- `npm run package` builds a clean `dist/` and writes `release/jev-inbox-<version>.zip`, and fails when `package.json` and `manifest.json` carry different versions. CI builds the zip on every push and pull request.
- `dist/` holds only the extension. The demo and the store stub build to `dev-dist/` and read their version from `manifest.json`.

## 0.1.0

First version.

- Shows Gmail's unread rows at the top of the visible list on the inbox, the other inbox tabs, search results, and labels and other folders, each switchable in the popup, without changing Gmail's own DOM order.
- Classifies unread rows with TypeSafe Jev on Vercel AI Gateway or on TypeSafe's own API: critical rows first, sorted by urgency, with chips for the user's own labels above a sensitivity threshold.
- A status bar above the list shows the unread count, in-flight progress and errors.
- Classification waits for the first-run privacy notice in the popup. API keys stay in `chrome.storage.local`, restricted to trusted extension contexts, and only the service worker reads them.
