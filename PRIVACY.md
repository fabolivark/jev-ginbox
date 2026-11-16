# Privacy

Jev Inbox reads the message list Gmail renders and sends a small amount of metadata about unread rows, and about read rows if you turn that on, to an AI provider so those rows can be classified. Nothing is sent until you accept the first-run notice in the popup. This page describes exactly what happens, and it is written so it can serve as the Chrome Web Store privacy policy.

## What is collected and sent

For each unread row in the Gmail list currently loaded, and for each read row too when "Also classify read mail" is on in the popup, on the views you enabled in the popup, and only for rows the extension has not classified before, one request leaves your browser. Its body holds exactly two things, a `state` and a set of `questions`.

The `state` has exactly these five fields, read from the row Gmail renders:

- `from_name`: sender display name
- `from_email`: sender address
- `subject`: subject
- `snippet`: the snippet Gmail renders in the list. The snippet is the first part of the email body, usually the first 100 to 200 characters, so it can carry body text such as a verification code, part of a reset link's message, or the opening of a medical or legal email.
- `date`: the date Gmail shows for the row

The `questions` are the same for every row except your labels: one fixed question about whether the row is critical, one fixed urgency question, and one question per label, keyed by the label's id, with the label's name in the question and its description as the criteria. Do not put sensitive information in a label name or description.

The request is authenticated with the API key of the provider you selected.

Nothing else is sent. The rest of the email body beyond the snippet, attachments, recipients, Gmail thread and message ids, your account, your email address, identifiers of your browser or device, and your browsing history are not collected and not sent.

Read rows are off by default. If you turn on "Also classify read mail", the read rows of every list you open on an enabled view are sent the same way as unread ones, with the same five fields, so the snippets of mail you have already read leave your browser as well.

Search results are off by default. If you turn on "Search" under "Show on", the unread rows of every search you run are classified, so a search such as `password reset` sends the snippets of those emails as well.

## Where it goes

The row data goes to the provider you select in the popup, and from there to TypeSafe, which runs Jev:

- Vercel AI Gateway (`https://ai-gateway.vercel.sh`), using the Vercel AI Gateway key you pasted. The Gateway forwards each request to TypeSafe's Jev model (`typesafe-ai/jev`), so Vercel and TypeSafe both process it.
- TypeSafe (`https://api.typesafe.ai`), using the TypeSafe key you pasted. Only TypeSafe processes it.

Both act as processors. Requests are made under your own key and your own account, so each provider's terms, data policies and retention apply to them; this page does not describe either provider's retention. Jev Inbox has no servers of its own: nothing is proxied, relayed, or stored anywhere except your browser and the providers above. No analytics, no telemetry, no tracking, no advertising identifiers.

"Test connection" in the popup sends one fixed dummy state (the text of a connection test) and no email data.

## The Critical badge is a model guess

Whether a row is critical, how urgent it is, and which labels it gets are answers Jev gives from the five fields above. They are a guess, not a verification. Anyone who can send you an email controls its sender name, subject and snippet, and can write them to look urgent or to address the model directly, so a phishing email can earn the Critical badge and the top of the list. The badge and the order never check that a sender is genuine. Treat them as a sorting hint, never as a sign that an email is safe or legitimate.

## What is stored locally

Everything the extension keeps lives in `chrome.storage.local`, inside your browser profile:

- settings: provider choice, your provider API keys, the last four characters of each key so the popup can show that a key is saved without reading it back, the enabled switch, the Strictness threshold, the per-view toggles, the "Also classify read mail" toggle, and the first-run acknowledgement
- your labels: name and description
- `authFailed`: the name of the provider whose last call or connection test was rejected with 401 or 403, so the popup can say the key was rejected. It is removed when a call to that provider succeeds or its key is saved or removed, and it never reaches the content script.
- the classification cache: one entry per classified row, keyed by thread id, last message id, provider, and a hash of your labels, with a timestamp. The service worker trims the cache to 4000 entries once it passes 5000, deleting the oldest first.

The extension restricts this storage to its own trusted pages, the service worker and the popup, so the content script running on Gmail cannot read it. The content script asks the service worker for the named settings and the cache entries and never receives an API key. Only the service worker reads your API keys, and only to call the provider you selected.

Rows classify again when the cache entry they would use is gone: "Clear cache" removes every entry, editing a label changes the labels hash, and switching providers changes the key.

## How to delete everything

- "Clear cache" in the popup removes every cached classification. Your settings and labels stay, and the unread rows of the list you are looking at classify again, with its read rows when "Also classify read mail" is on.
- Removing the extension from `chrome://extensions` deletes its storage, including your keys, labels, and the cache.

## Changes

If what is sent or stored changes, this page changes with it, and the change is visible in the repository history at https://github.com/fabolivark/jev-ginbox.
