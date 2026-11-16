import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RowFilter } from '../src/filter';
import {
  rowsToSelect,
  selectOptions,
  selectTitle,
  selectedText,
  type SelectableRow,
} from '../src/selection';
import type { Classification, LabelConfig } from '../src/shared';

const labels: LabelConfig[] = [
  { id: 'visa', name: 'Visa', description: 'Immigration' },
  { id: 'money', name: 'Money', description: 'Invoices' },
];

const urgentVisa: Classification = {
  criticalProbability: 0.95,
  urgencyScore: 3,
  labels: { visa: 0.9, money: 0.05 },
};
const money: Classification = {
  criticalProbability: 0.1,
  urgencyScore: 0,
  labels: { visa: 0.05, money: 0.8 },
};
const weakMoney: Classification = {
  criticalProbability: 0.1,
  urgencyScore: 0,
  labels: { visa: 0.05, money: 0.6 },
};

function row(key: string, classification: Classification | undefined, extra: Partial<SelectableRow> = {}): SelectableRow {
  return { key, classification, checked: false, hidden: false, ...extra };
}

const moneyFilter: RowFilter = { kind: 'label', id: 'money' };
const criticalFilter: RowFilter = { kind: 'critical' };

test('rowsToSelect picks exactly the unticked rows that show the chip', () => {
  const rows = [
    row('a', money),
    row('b', urgentVisa),
    row('c', weakMoney),
    row('d', money),
  ];
  assert.deepEqual(rowsToSelect(rows, moneyFilter, labels, 0.7), ['a', 'd']);
  assert.deepEqual(rowsToSelect(rows, criticalFilter, labels, 0.7), ['b']);
  assert.deepEqual(rowsToSelect(rows, moneyFilter, labels, 0.5), ['a', 'c', 'd']);
});

test('rowsToSelect never selects unclassified, hidden or already ticked rows', () => {
  const rows = [
    row('unclassified', undefined),
    row('hidden', money, { hidden: true }),
    row('ticked', money, { checked: true }),
    row('fresh', money),
  ];
  assert.deepEqual(rowsToSelect(rows, moneyFilter, labels, 0.7), ['fresh']);
});

test('rowsToSelect ignores a label that is no longer configured', () => {
  assert.deepEqual(rowsToSelect([row('a', money)], { kind: 'label', id: 'gone' }, labels, 0.7), []);
});

test('selectOptions counts only the rows on screen and lists the labels present', () => {
  const rows = [
    row('a', money),
    row('b', urgentVisa),
    row('c', money, { hidden: true }),
    row('d', undefined),
    row('e', money, { checked: true }),
  ];
  assert.deepEqual(selectOptions(rows, labels, 0.7), [
    { token: 'critical', name: 'Critical', count: 1, hue: null },
    { token: 'label:visa', name: 'Visa', count: 1, hue: 0 },
    { token: 'label:money', name: 'Money', count: 2, hue: 1 },
  ]);
  assert.deepEqual(selectOptions([row('d', undefined)], labels, 0.7), []);
});

test('selectedText and selectTitle name the count and the label', () => {
  assert.equal(selectedText(1), '1 selected');
  assert.equal(selectedText(12), '12 selected');
  assert.equal(selectTitle('Money', 1), 'Select the 1 loaded row with Money in Gmail');
  assert.equal(selectTitle('Money', 3), 'Select the 3 loaded rows with Money in Gmail');
});
