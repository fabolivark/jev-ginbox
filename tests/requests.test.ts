import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest } from '../src/requests';
import { MAX_CLASSIFY_BATCH, MAX_LABELS, type EmailState, type LabelConfig } from '../src/shared';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';

const gmailTab = {
  id: RUNTIME_ID,
  url: 'https://mail.google.com/mail/u/0/#inbox',
  tab: { id: 7 } as chrome.tabs.Tab,
} satisfies chrome.runtime.MessageSender;

const popup = {
  id: RUNTIME_ID,
  url: `chrome-extension://${RUNTIME_ID}/popup.html`,
} satisfies chrome.runtime.MessageSender;

function email(n: number): EmailState {
  return {
    threadId: `thread${n}`,
    legacyThreadId: `legacy${n}`,
    lastMessageId: `msg${n}`,
    fromName: 'Sender',
    fromEmail: 'sender@example.com',
    subject: 'Subject',
    snippet: 'Snippet',
    date: 'Nov 13',
  };
}

function label(n: number): LabelConfig {
  return { id: `l${n}`, name: `Label ${n}`, description: 'Description' };
}

function classify(emails: number, labels = 1) {
  return {
    type: 'classify',
    emails: Array.from({ length: emails }, (_, i) => email(i)),
    labels: Array.from({ length: labels }, (_, i) => label(i)),
  };
}

test('classify is accepted from the Gmail content script', () => {
  const request = parseRequest(classify(3), gmailTab, RUNTIME_ID);
  assert.equal(request?.type, 'classify');
});

test('classify is rejected from another extension', () => {
  assert.equal(parseRequest(classify(3), { ...gmailTab, id: 'other' }, RUNTIME_ID), undefined);
});

test('classify is rejected from a page that is not Gmail', () => {
  const sender = { ...gmailTab, url: 'https://mail.google.com.evil.example/mail' };
  assert.equal(parseRequest(classify(3), sender, RUNTIME_ID), undefined);
  assert.equal(parseRequest(classify(3), { ...gmailTab, url: 'http://mail.google.com/' }, RUNTIME_ID), undefined);
  const { url: _url, ...noUrl } = gmailTab;
  assert.equal(parseRequest(classify(3), noUrl, RUNTIME_ID), undefined);
});

test('classify is rejected from the popup', () => {
  assert.equal(parseRequest(classify(3), popup, RUNTIME_ID), undefined);
});

test('classify batches are capped', () => {
  assert.equal(parseRequest(classify(MAX_CLASSIFY_BATCH), gmailTab, RUNTIME_ID)?.type, 'classify');
  assert.equal(parseRequest(classify(MAX_CLASSIFY_BATCH + 1), gmailTab, RUNTIME_ID), undefined);
  assert.equal(parseRequest(classify(1, MAX_LABELS + 1), gmailTab, RUNTIME_ID), undefined);
});

test('classify with malformed rows is rejected', () => {
  const message = { type: 'classify', emails: [{ threadId: 'x' }], labels: [] };
  assert.equal(parseRequest(message, gmailTab, RUNTIME_ID), undefined);
});

test('test is accepted only from the popup', () => {
  assert.equal(parseRequest({ type: 'test' }, popup, RUNTIME_ID)?.type, 'test');
  assert.equal(parseRequest({ type: 'test' }, gmailTab, RUNTIME_ID), undefined);
  assert.equal(parseRequest({ type: 'test' }, { ...popup, id: 'other' }, RUNTIME_ID), undefined);
});

test('unknown messages are rejected', () => {
  assert.equal(parseRequest({ type: 'nope' }, popup, RUNTIME_ID), undefined);
  assert.equal(parseRequest(null, popup, RUNTIME_ID), undefined);
});
