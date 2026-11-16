import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  MAX_LABELS,
  labelIssue,
  labelIssueText,
  labelsToSave,
  routeKey,
  viewFromHash,
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
