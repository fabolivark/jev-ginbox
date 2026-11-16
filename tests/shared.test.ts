import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  MAX_LABELS,
  cacheEntry,
  classificationOf,
  labelIssue,
  labelIssueText,
  labelsToSave,
  routeKey,
  threadMetaOf,
  viewFromHash,
  type EmailState,
} from '../src/shared';

test('viewFromHash maps Gmail routes to views', () => {
  assert.equal(viewFromHash(''), 'inbox');
  assert.equal(viewFromHash('#inbox'), 'inbox');
  assert.equal(viewFromHash('#category/social'), 'tabs');
  assert.equal(viewFromHash('#search/from%3Ahr'), 'search');
  assert.equal(viewFromHash('#label/Work'), 'other');
  assert.equal(viewFromHash('#inbox/FMfcgzQbfLmPqLbRbHrWjXrWbJfSdNkT'), null);
});

test('routeKey drops the open thread and keeps the query', () => {
  assert.equal(routeKey('#search/from%3Ahr/FMfcgzQbfLmPqLbRbHrWjXrWbJfSdNkT'), 'search/from:hr');
  assert.equal(routeKey('#inbox?compose=new'), 'inbox?compose=new');
});

test('search results are opt-in by default', () => {
  assert.equal(DEFAULT_SETTINGS.viewSearch, false);
  assert.equal(DEFAULT_SETTINGS.viewOther, false);
});

test('labelIssue flags the empty fields of a label after trimming', () => {
  assert.equal(labelIssue({ id: 'a', name: ' Visa ', description: 'IND letters' }), undefined);
  assert.deepEqual(labelIssue({ id: 'a', name: '  ', description: 'IND letters' }), { name: true, description: false });
  assert.deepEqual(labelIssue({ id: 'a', name: 'Visa', description: '' }), { name: false, description: true });
  assert.deepEqual(labelIssue({ id: 'a', name: '', description: ' ' }), { name: true, description: true });
});

test('labelIssueText names what is missing', () => {
  assert.equal(labelIssueText({ name: true, description: false }), 'Add a name to save this label.');
  assert.equal(labelIssueText({ name: false, description: true }), 'Add a description to save this label.');
  assert.equal(labelIssueText({ name: true, description: true }), 'Add a name and a description to save this label.');
});

test('labelsToSave saves each complete label on its own and keeps ids', () => {
  const saved = [{ id: 'money', name: 'Money', description: 'Invoices' }];
  const draft = [
    { id: 'visa', name: ' Visa ', description: ' IND letters ' },
    { id: 'half', name: 'Half typed', description: '' },
    { id: 'money', name: '', description: 'Invoices and payments' },
  ];
  assert.deepEqual(labelsToSave(draft, saved), [
    { id: 'visa', name: 'Visa', description: 'IND letters' },
    { id: 'money', name: 'Money', description: 'Invoices' },
  ]);
  const many = Array.from({ length: MAX_LABELS + 2 }, (_, i) => ({ id: `l${i}`, name: 'n', description: 'd' }));
  assert.equal(labelsToSave(many, []).length, MAX_LABELS);
});

const email: EmailState = {
  threadId: 'thread-f:1',
  legacyThreadId: 'abc',
  lastMessageId: 'def',
  fromName: 'Ana Bank',
  fromEmail: 'ana@bank.example',
  subject: 'Invoice 42',
  snippet: 'Your invoice is attached',
  date: 'Mon, Nov 3, 2026, 9:14 AM',
};
const scores = { criticalProbability: 0.2, urgencyScore: 1, labels: { money: 0.9 } };

test('cacheEntry stores the sender, subject and date next to the scores, never the snippet', () => {
  const entry = cacheEntry(scores, email, 1234);
  assert.deepEqual(entry, {
    ...scores,
    ts: 1234,
    thread: {
      fromName: 'Ana Bank',
      fromEmail: 'ana@bank.example',
      subject: 'Invoice 42',
      date: 'Mon, Nov 3, 2026, 9:14 AM',
    },
  });
  assert.equal(JSON.stringify(entry).includes('attached'), false);
});

test('cacheEntry caps long fields so the cache stays small', () => {
  const entry = cacheEntry(scores, { ...email, subject: 'x'.repeat(1000), fromName: 'n'.repeat(1000) }, 1);
  assert.equal(entry.thread.subject.length, 200);
  assert.equal(entry.thread.fromName.length, 100);
});

test('classificationOf keeps only the scores of a stored entry', () => {
  assert.deepEqual(classificationOf(cacheEntry(scores, email, 1)), scores);
  assert.deepEqual(classificationOf({ ...scores, ts: 1 }), scores);
  assert.equal(classificationOf({ broken: true }), undefined);
});

test('threadMetaOf reads the stored sender and tolerates entries written before it existed', () => {
  assert.deepEqual(threadMetaOf(cacheEntry(scores, email, 1))?.fromEmail, 'ana@bank.example');
  assert.equal(threadMetaOf({ ...scores, ts: 1 }), undefined);
  assert.equal(threadMetaOf({ ...scores, thread: { fromEmail: 3 } }), undefined);
  assert.equal(threadMetaOf(null), undefined);
});
