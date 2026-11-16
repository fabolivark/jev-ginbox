import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterNote,
  filterOptions,
  filterRoute,
  filterToken,
  isCritical,
  matchesFilter,
  parseFilterToken,
  shownLabels,
  type RowFilter,
} from '../src/filter';
import type { Classification, LabelConfig } from '../src/shared';

const labels: LabelConfig[] = [
  { id: 'visa', name: 'Visa', description: 'Immigration' },
  { id: 'money', name: 'Money', description: 'Invoices' },
  { id: 'home', name: 'Home', description: 'Rent' },
];

const urgentVisa: Classification = {
  criticalProbability: 0.95,
  urgencyScore: 3,
  labels: { visa: 0.9, money: 0.05, home: 0.05 },
};
const moneyAndHome: Classification = {
  criticalProbability: 0.1,
  urgencyScore: 0,
  labels: { visa: 0.05, money: 0.8, home: 0.7 },
};
const nothing: Classification = {
  criticalProbability: 0.1,
  urgencyScore: 0,
  labels: { visa: 0.05, money: 0.05, home: 0.05 },
};

const critical: RowFilter = { kind: 'critical' };
const money: RowFilter = { kind: 'label', id: 'money' };

test('filter tokens round-trip and reject unknown labels', () => {
  assert.equal(filterToken(critical), 'critical');
  assert.equal(filterToken(money), 'label:money');
  assert.deepEqual(parseFilterToken('critical', labels), critical);
  assert.deepEqual(parseFilterToken('label:money', labels), money);
  assert.equal(parseFilterToken('label:gone', labels), null);
  assert.equal(parseFilterToken('bogus', labels), null);
  assert.equal(parseFilterToken(undefined, labels), null);
});

test('a row matches exactly the chips it shows', () => {
  assert.equal(isCritical(urgentVisa, 0.7), true);
  assert.equal(isCritical(moneyAndHome, 0.7), false);
  assert.deepEqual(
    shownLabels(moneyAndHome, labels, 0.7).map((label) => label.id),
    ['money', 'home']
  );
  assert.deepEqual(shownLabels(moneyAndHome, labels, 0.75).map((label) => label.id), ['money']);
  assert.equal(matchesFilter(critical, urgentVisa, labels, 0.7), true);
  assert.equal(matchesFilter(critical, moneyAndHome, labels, 0.7), false);
  assert.equal(matchesFilter(money, moneyAndHome, labels, 0.7), true);
  assert.equal(matchesFilter(money, moneyAndHome, labels, 0.85), false);
  assert.equal(matchesFilter(money, urgentVisa, labels, 0.7), false);
  assert.equal(matchesFilter(money, undefined, labels, 0.7), false);
});

test('filterOptions lists Critical and the labels present, and always the active one', () => {
  const rows = [urgentVisa, moneyAndHome, nothing, undefined];
  assert.deepEqual(filterOptions(labels, rows, 0.7, null), [
    { token: 'critical', name: 'Critical', count: 1, hue: null },
    { token: 'label:visa', name: 'Visa', count: 1, hue: 0 },
    { token: 'label:money', name: 'Money', count: 1, hue: 1 },
    { token: 'label:home', name: 'Home', count: 1, hue: 2 },
  ]);
  assert.deepEqual(filterOptions(labels, [nothing], 0.7, money), [
    { token: 'label:money', name: 'Money', count: 0, hue: 1 },
  ]);
  assert.deepEqual(filterOptions(labels, [], 0.7, null), []);
});

test('filterRoute ignores the open thread and the query, so Compose keeps the filter', () => {
  assert.equal(filterRoute('#inbox'), 'inbox');
  assert.equal(filterRoute('#inbox?compose=new'), 'inbox');
  assert.equal(filterRoute('#inbox/FMfcgzQbfLmPqLbRbHrWjXrWbJfSdNkT'), 'inbox');
  assert.equal(filterRoute(''), 'inbox');
  assert.notEqual(filterRoute('#category/social'), filterRoute('#inbox'));
  assert.notEqual(filterRoute('#search/a'), filterRoute('#search/b'));
});

test('filterNote says the filter covers loaded rows only', () => {
  assert.equal(
    filterNote('Money', 2, 10),
    'Showing 2 of 10 loaded rows with Money. Filters this page only, not the whole mailbox.'
  );
  assert.equal(
    filterNote('Critical', 1, 1),
    'Showing 1 of 1 loaded row with Critical. Filters this page only, not the whole mailbox.'
  );
});
