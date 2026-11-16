import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheVersion, type LabelConfig } from '../src/shared';
import {
  ALL_LABELS,
  GMAIL_QUERY_MAX,
  NO_LABEL,
  filterThreads,
  gmailAccounts,
  gmailSearchUrl,
  groupThreads,
  isSearchableEmail,
  senderQueries,
  triageThreads,
  type TriageFilter,
} from '../src/triage';

const labels: LabelConfig[] = [
  { id: 'money', name: 'Money', description: 'Invoices' },
  { id: 'news', name: 'Newsletters', description: 'Bulk mail' },
];
const version = cacheVersion(labels, 'gateway');

function entry(
  fromEmail: string,
  subject: string,
  ts: number,
  scores: { money?: number; news?: number; urgency?: number; critical?: number } = {}
): Record<string, unknown> {
  return {
    criticalProbability: scores.critical ?? 0.1,
    urgencyScore: scores.urgency ?? 0,
    labels: { money: scores.money ?? 0.05, news: scores.news ?? 0.05 },
    ts,
    thread: { fromName: fromEmail.split('@')[0] ?? '', fromEmail, subject, date: `d${ts}` },
  };
}

const stored: Record<string, unknown> = {
  provider: 'gateway',
  labels,
  threshold: 0.7,
  [`crit:t1|m1|${version}`]: entry('Billing@Shop.example', 'Receipt 1', 10, { money: 0.9 }),
  [`crit:t2|m2|${version}`]: entry('billing@shop.example', 'Receipt 2', 30, { money: 0.8, news: 0.95 }),
  [`crit:t3|m3|${version}`]: entry('deals@shop.example', 'Sale', 20, { news: 0.9 }),
  [`crit:t4|m4|${version}`]: entry('ana@friends.example', 'Dinner?', 40, { urgency: 2 }),
  [`crit:t5|m5|${version}`]: entry('bank@bank.example', 'Statement', 50, { money: 0.75, urgency: 3, critical: 0.9 }),
  [`crit:t6|m6|${version}`]: { criticalProbability: 0.1, urgencyScore: 0, labels: {}, ts: 5 },
  [`crit:t7|m7|${version}`]: entry('', 'No address', 6),
  [`crit:t8|m8|gateway:old`]: entry('old@old.example', 'Old version', 7),
  [`crit:t9|m9|${version}`]: { broken: true },
};

test('triageThreads reads the current version and counts entries saved without a sender', () => {
  const { threads, missing } = triageThreads(stored);
  assert.deepEqual(threads.map((t) => t.key).sort(), ['t1|m1', 't2|m2', 't3|m3', 't4|m4', 't5|m5']);
  assert.equal(missing, 2);
});

test('the top label is the most probable label that clears the threshold', () => {
  const byKey = new Map(triageThreads(stored).threads.map((t) => [t.key, t]));
  assert.equal(byKey.get('t1|m1')?.labelId, 'money');
  assert.equal(byKey.get('t2|m2')?.labelId, 'news');
  assert.equal(byKey.get('t4|m4')?.labelId, null);
  assert.equal(byKey.get('t5|m5')?.critical, true);
  assert.equal(byKey.get('t5|m5')?.urgency, 3);
});

test('triageThreads uses the default threshold and provider when none is stored', () => {
  const { threads } = triageThreads({ ...stored, threshold: undefined, provider: undefined });
  assert.equal(threads.length, 5);
  const { threads: other } = triageThreads({ ...stored, provider: 'typesafe' });
  assert.equal(other.length, 0);
});

test('groupThreads groups by label in label order, then by sender, with counts and the latest subject', () => {
  const groups = groupThreads(triageThreads(stored).threads, labels);
  assert.deepEqual(
    groups.map((g) => [g.id, g.name, g.count]),
    [
      ['money', 'Money', 2],
      ['news', 'Newsletters', 2],
      [null, 'No label', 1],
    ]
  );
  const news = groups[1];
  assert.deepEqual(
    news?.senders.map((s) => [s.email, s.count, s.latestSubject, s.latestDate]),
    [
      ['billing@shop.example', 1, 'Receipt 2', 'd30'],
      ['deals@shop.example', 1, 'Sale', 'd20'],
    ]
  );
});

test('groupThreads merges a sender across letter case and sorts senders by count', () => {
  const threads = triageThreads({
    ...stored,
    [`crit:t2|m2|${version}`]: entry('billing@shop.example', 'Receipt 2', 30, { money: 0.8 }),
  }).threads;
  const money = groupThreads(threads, labels)[0];
  assert.deepEqual(
    money?.senders.map((s) => [s.email, s.count, s.latestSubject]),
    [
      ['billing@shop.example', 2, 'Receipt 2'],
      ['bank@bank.example', 1, 'Statement'],
    ]
  );
});

test('groupThreads leaves out empty groups', () => {
  assert.deepEqual(groupThreads([], labels), []);
});

const all: TriageFilter = { label: ALL_LABELS, minUrgency: 0, maxUrgency: 3, text: '' };

test('filterThreads filters by label, by no label, by urgency range and by sender or subject text', () => {
  const { threads } = triageThreads(stored);
  const keys = (filter: TriageFilter): string[] => filterThreads(threads, filter).map((t) => t.key).sort();
  assert.equal(keys(all).length, 5);
  assert.deepEqual(keys({ ...all, label: 'money' }), ['t1|m1', 't5|m5']);
  assert.deepEqual(keys({ ...all, label: NO_LABEL }), ['t4|m4']);
  assert.deepEqual(keys({ ...all, minUrgency: 2 }), ['t4|m4', 't5|m5']);
  assert.deepEqual(keys({ ...all, maxUrgency: 0 }), ['t1|m1', 't2|m2', 't3|m3']);
  assert.deepEqual(keys({ ...all, text: 'SHOP' }), ['t1|m1', 't2|m2', 't3|m3']);
  assert.deepEqual(keys({ ...all, text: 'dinner' }), ['t4|m4']);
});

test('isSearchableEmail accepts plain addresses and refuses ones that could change the query', () => {
  for (const ok of ['a@b.example', 'first.last+tag@mail.example', "o'neil@x.example"]) {
    assert.equal(isSearchableEmail(ok), true, ok);
  }
  for (const bad of ['', 'nobody', 'a b@x.example', 'a@x.example)', '"a"@x.example', '-a@x.example', 'a@x.example OR b', '{a@x.example}', 'a@']) {
    assert.equal(isSearchableEmail(bad), false, bad);
  }
});

test('senderQueries builds one from:() search, deduplicated, with in:inbox when asked', () => {
  assert.deepEqual(senderQueries(['a@x.example', 'B@y.example', 'b@y.example'], { inboxOnly: false }), [
    'from:(a@x.example OR b@y.example)',
  ]);
  assert.deepEqual(senderQueries(['a@x.example'], { inboxOnly: true }), ['in:inbox from:(a@x.example)']);
  assert.deepEqual(senderQueries(['bad address', 'nobody'], { inboxOnly: true }), []);
});

test('senderQueries splits into several searches so none passes the length limit', () => {
  const emails = Array.from({ length: 200 }, (_, i) => `sender${i}@newsletter-${i}.example`);
  const queries = senderQueries(emails, { inboxOnly: true });
  assert.ok(queries.length > 1, 'split');
  for (const query of queries) {
    assert.ok(query.length <= GMAIL_QUERY_MAX, `${query.length} <= ${GMAIL_QUERY_MAX}`);
    assert.match(query, /^in:inbox from:\([^()]+\)$/);
  }
  const found = queries.flatMap((q) => q.replace(/^in:inbox from:\(|\)$/g, '').split(' OR '));
  assert.deepEqual(found, emails);
});

test('senderQueries respects a custom limit and keeps an address longer than it on its own', () => {
  const queries = senderQueries(['a@x.example', 'b@x.example', 'c@x.example'], { inboxOnly: false, maxLength: 34 });
  assert.deepEqual(queries, ['from:(a@x.example OR b@x.example)', 'from:(c@x.example)']);
  assert.deepEqual(senderQueries(['long-address@x.example'], { inboxOnly: false, maxLength: 10 }), [
    'from:(long-address@x.example)',
  ]);
});

test('gmailSearchUrl opens the search in the chosen Gmail account', () => {
  assert.equal(
    gmailSearchUrl('in:inbox from:(a+b@x.example OR c@y.example)', 0),
    'https://mail.google.com/mail/u/0/#search/in%3Ainbox%20from%3A(a%2Bb%40x.example%20OR%20c%40y.example)'
  );
  assert.match(gmailSearchUrl('from:(a@x.example)', 2), /^https:\/\/mail\.google\.com\/mail\/u\/2\/#search\//);
});

test('gmailAccounts lists the signed-in account numbers of open Gmail tabs, in order', () => {
  assert.deepEqual(
    gmailAccounts([
      'https://mail.google.com/mail/u/1/#inbox',
      undefined,
      'https://mail.google.com/mail/u/0/#search/x',
      'https://mail.google.com/mail/u/1/#label/Work',
      'https://example.com/mail/u/5/',
      'https://mail.google.com/mail/',
    ]),
    [0, 1]
  );
  assert.deepEqual(gmailAccounts([]), []);
});
