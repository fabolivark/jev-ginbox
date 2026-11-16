# Chrome Web Store listing (draft)

Draft text for the store listing. Nothing here is published.

## Listing details

- Category: Productivity > Communication, the category for email management (confirm in the Developer Dashboard dropdown when submitting)
- Language: English
- Homepage URL: https://github.com/fabolivark/jev-ginbox
- Privacy policy URL: https://github.com/fabolivark/jev-ginbox/blob/main/PRIVACY.md
- Support URL: none. Issues are disabled on the repository, so the support email below is the only contact.
- Support email: TODO for the owner to fill in before submitting. Do not publish without a real, monitored address.

## Short description

Unread Gmail first, critical at the top, with your own labels, classified by TypeSafe Jev.

## Long description

Unread Gmail first, critical at the top.

Jev Inbox reorders the message list Gmail already shows. Unread mail moves above read mail, and the messages that matter most move above everything else: a person waiting on a reply, an invoice, a deadline, a security alert. Every classified row carries chips for your own labels, so a visa appointment and a bank statement can be spotted at a glance.

- Your views: inbox, other inbox tabs, search results, and labels and other folders, each switchable.
- Your labels: name a label, describe what belongs under it, and Jev answers one question per label.
- Your sensitivity: choose how confident a classification has to be before a row counts as critical.
- Your provider: Vercel AI Gateway or TypeSafe, with your own key.

Only the unread rows in the Gmail list currently loaded are classified, plus its read rows if you turn on "Also classify read mail", only their sender, subject, snippet and date are sent, and your label names and descriptions go with them as the criteria Jev answers. The snippet is the first part of the email body; the rest of the body and attachments are never read or sent. On Vercel AI Gateway, Vercel forwards each request to TypeSafe, which runs Jev. The Critical badge is a model guess from text the sender wrote and can be gamed by a phishing email, so treat it as a sorting hint, not a safety signal. Results are cached in your browser. There is no account, no analytics, and no server of ours.

## Single purpose statement

Jev Inbox sorts and labels the unread messages Gmail already shows in the list currently loaded, and its read messages too when the user turns that on, and nothing else.

## Permission justifications

- `storage`: saves your settings (provider, API keys, enabled switch, sensitivity, view toggles, first-run acknowledgement), your labels, and the classification cache, all in `chrome.storage.local` in your own browser profile.
- `https://mail.google.com/*`: reads the rendered message list to identify unread rows, and read rows when "Also classify read mail" is on, and their sender, subject, snippet and date, reorders those rows, and injects the status bar and label chips.
- `https://ai-gateway.vercel.sh/*`: sends the sender, subject, snippet (the first part of the body) and date of unread rows, and of read rows when "Also classify read mail" is on, with the user's label names and descriptions, for classification when Vercel AI Gateway is the selected provider, using the user's own key.
- `https://api.typesafe.ai/*`: sends the sender, subject, snippet (the first part of the body) and date of unread rows, and of read rows when "Also classify read mail" is on, with the user's label names and descriptions, for classification when TypeSafe is the selected provider, using the user's own key.

No other hosts are requested. The extension makes no request to any server of its own.

## Data use disclosure answers

- What data is collected: fields of rows in the Gmail list, specifically sender display name, sender address, subject, snippet and date of unread rows, and of read rows when "Also classify read mail" is on, plus the user's own label names and descriptions, which are sent as the criteria for the label questions. Not the body beyond the snippet Gmail shows, which is its first part, not attachments, not the user's contacts, not their browsing history.
- How the data is used: sent to the AI provider the user selected (Vercel AI Gateway forwards it to TypeSafe, which runs Jev), to classify each row as critical or not, how urgent it is, and which of the user's labels it belongs to, where each label name and description is the criteria for that label's answer. Results are shown in the Gmail list.
- Is data sold to third parties: no.
- Is data used or transferred for purposes unrelated to the item's single purpose: no.
- Is data used or transferred to determine creditworthiness or for lending purposes: no.
- Transfer to third parties: only to the AI provider the user selected (Vercel AI Gateway or TypeSafe), under the user's own key and account, and only for classification.
- Authentication information: the provider API key the user pastes is stored locally in `chrome.storage.local` and sent only to that provider as an authorization header. The popup keeps only the last four characters of each key so it can show that a key is saved without reading it back.
- Personal communications: the sender, subject, snippet and date of unread rows, and of read rows when the user turns that on, are sent to the selected provider for classification, together with the user's label names and descriptions as criteria. The snippet is the first part of the email body, so it can carry body text such as a verification code; the rest of the body and attachments are not read or sent.
- Storage and deletion: settings, keys, labels and the classification cache stay in the browser. "Clear cache" deletes cached classifications, which sends the unread rows of the current list through classification again, and removing the extension deletes all of it.

## Images

Built by `npm run store-images` from the sources in `dev/store/`. Screenshots are made-up mail only, no real inbox.

- `docs/store/01-unread-first.png` (1280x800): the inbox with unread mail first and the critical rows on top, chips in place.
- `docs/store/02-your-labels.png` (1280x800): the popup's labels editor over the reordered list.
- `docs/store/03-dark-theme.png` (1280x800): the same list in Gmail's dark theme.
- `docs/store/04-privacy.png` (1280x800): the first-run notice, before anything is sent.
- `docs/store/05-search-and-key.png` (1280x800): search results, with the popup's Vercel AI Gateway connection.
- `docs/store/promo-small.png` (440x280): the small promo tile.
- `docs/store/promo-marquee.png` (1400x560): the marquee promo tile.
