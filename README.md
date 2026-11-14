# Jev Inbox for Gmail

Jev Inbox is a Chrome extension that reorders the message list Gmail already renders, on screen only: unread mail moves to the top, the messages that matter most sit above the rest, and every classified row carries chips for your own labels. A thin bar above the list shows the unread count, in-flight progress, and errors. You choose the views it touches (inbox, other inbox tabs, search results, labels and other folders), the provider it classifies through, your labels, and how confident a classification has to be before a row counts as critical. Nothing moves in Gmail's own DOM, so a click, a checkbox, a star, and a hover action always land on the row you see.

![Chrome window with the Gmail inbox reordered: unread mail first, critical rows on top with their label chips](docs/store/01-unread-first.png)

## How it works

The content script reads only what the list shows for each unread row: sender display name, sender address, subject, the snippet Gmail renders, and the date. The snippet is the first part of the email body, so that much body text is sent; the rest of the body and attachments are never read and never sent. Search results are off by default; turn on "Search" in the popup to classify the unread rows of your searches too. Read rows are not classified by default; turn on "Also classify read mail" in the popup and the read rows of the loaded list are read and sent the same way, so they get chips and the Critical badge too.

Rows are sent in batches of 20 to the service worker, which asks TypeSafe Jev for one evaluation per row:

- `critical`: is this email critical for the recipient (a person waiting on a reply, money or legal matters, a hard deadline, a security or account event)?
- `urgency`: a score from not urgent to immediately urgent.
- One boolean question per label, with your description as the criteria.

Critical rows come first, sorted by urgency and then by critical probability, then the remaining unread rows, then read rows. Read rows stay below the unread ones in Gmail's order even when "Also classify read mail" gives them a Critical badge. A row counts as critical when its critical probability reaches the sensitivity you set.

The bar and the chips follow Gmail's own theme, which is a Gmail setting and not the system one: the extension reads the list's background color and switches to dark colors when it is dark, with text that keeps WCAG AA contrast in both themes.

The Critical badge and the order are a model guess from text the sender wrote. A sender controls their name, subject and snippet, so a phishing email written to sound urgent, or written to instruct the model, can earn the badge and the top slot. Nothing checks that a sender is genuine: treat the badge as a sorting hint, never as a sign that an email is safe. Results are cached in `chrome.storage.local` and reused across renders and tabs, and the cache is bounded to 5000 entries. Clearing the cache, editing a label, or switching providers sends the unread rows of the current list through classification again.

## Install from source

```bash
git clone https://github.com/iamomiid/jev-inbox.git
cd jev-inbox
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose "Load unpacked", and select the `dist/` folder. Open the extension popup to finish setup.

## Getting a key

Jev Inbox classifies through Jev, reachable either way:

- **Vercel AI Gateway**: create a key in the Vercel dashboard (`https://vercel.com/docs/ai-gateway`), pick "Vercel AI Gateway" in the popup, and paste the key.
- **TypeSafe**: create a key at `https://docs.typesafe.ai`, pick "TypeSafe" in the popup, and paste the key.

Keys stay in `chrome.storage.local`, are only read by the extension's service worker, and are sent only to the provider you selected. The popup keeps only the last four characters of each key, so it can show that one is saved without reading it back; Replace and Remove are there when you want to change it. "Test connection" runs one tiny classification on a fixed dummy state and reports the result inline.

## Labels

Labels are your own categories. Each label has a name, which becomes a chip, and a description, which becomes the question Jev answers. Both the name and the description are sent to the provider with each row as that question's criteria, so do not put sensitive information in them. Good descriptions name the concrete things that belong under the label:

- `Visa`: residence permits, IND letters, immigration appointments.
- `Money`: invoices, payments, bank statements, anything with an amount due.
- `School`: enrollment dates, teacher messages, permission slips.

A label needs both a name and a description before it is saved, and the list is capped at 15. The chip color follows the label's position in the list.

## Filtering

Every chip is a button. Click a label chip or the Critical badge on a row, or the matching button in the bar above the list, and the list shows only the rows that carry it; the bar names the active filter, how many rows match, and a Clear button. Click the active chip again, or Clear, to get the full list back. The buttons work from the keyboard with Tab, Enter and Space, and announce whether they are pressed.

The filter covers only the rows Gmail has loaded in the list you are looking at, usually one page of 50, not the whole mailbox. To find every message with a label across the mailbox, use Gmail's own search. Only classified rows can match, because only they carry chips. By default only unread rows are classified, so a message you open and return from drops out of the filtered view once Gmail marks it read; turn on "Also classify read mail" in the popup and the read rows of the loaded list are classified and filtered too, and a message stays in the filter after you read it. The filter hides rows on screen only: hidden rows keep their place in Gmail's list, so the list keeps its height with a blank space below the matches, and Gmail's own select-all and keyboard shortcuts still act on the hidden rows. It stays on while Gmail re-renders the list or opens Compose, and clears when you move to another list, edit the labels, switch providers, or turn the extension or that view off. Clicking a chip never opens, marks, or labels the message.

## Privacy

Only these fields of each unread row, and of each read row when "Also classify read mail" is on, leave your browser: sender name, sender address, subject, the snippet Gmail shows (the first part of the body), and the date, sent under your own key to the provider you chose, together with your label names and descriptions as the criteria for the label questions. On Vercel AI Gateway, Vercel forwards each request to TypeSafe, which runs Jev, so both process it; on TypeSafe, only TypeSafe does. No full bodies, no attachments, no analytics, no servers of our own. See [PRIVACY.md](PRIVACY.md) for the full description, including what is stored locally and how to delete it.

## Limitations

- Only the unread rows in the Gmail list currently loaded are classified, plus its read rows when "Also classify read mail" is on. Scrolling further classifies more as they appear.
- It only moves rows on screen, never in Gmail's DOM, so Gmail's own clicks, selection, and actions keep pointing at the row you see. It never marks, archives, deletes, or opens mail.
- One tab at a time does the work. Multiple open Gmail tabs share the same cache but each reorders its own list.
- Gmail's markup changes without notice. If Gmail renames the parts of the list, injection stops until the selectors are updated (`docs/gmail-dom.md`).
- Keyboard `j` and `k` follow Gmail's own row order, not the order on screen, so the selection jumps between slots as it moves down the list.
- It is an unofficial project. Not affiliated with Google, TypeSafe, or Vercel.

## Development

```bash
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
npm test           # unit tests
npm run e2e        # build, load dist/ in Chromium against a Gmail fixture, check the filter, screenshot the filtered list and the popup
```

`npm run build` writes `dist/`, which holds the unpacked extension.

`dev/demo.html` is a standalone Gmail-like list with made-up mail, a stubbed `chrome` API, and canned classifications, so nothing is sent anywhere. Build first, then open the file in Chrome. It accepts `?theme=dark` for the dark list and `?ack=0` to simulate a browser that has not accepted the first-run notice. Clicking a row resolves its thread the way Gmail does, by the row's index in the list, and reports it as `Opened: <subject>` in the demo line, so a wrong mapping shows up as a wrong subject.

`assets/icon.svg` is the icon source. The PNGs next to it are rendered from it and copied into `dist/assets` by the build.

## License

MIT, see [LICENSE](LICENSE).
