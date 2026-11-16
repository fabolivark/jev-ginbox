import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteLabelText, focusAfterDelete } from '../src/a11y';

test('deleteLabelText names the label the trash button deletes', () => {
  assert.equal(deleteLabelText('Visa', 1), 'Delete label Visa');
  assert.equal(deleteLabelText('  Money  ', 2), 'Delete label Money');
  assert.equal(deleteLabelText('', 3), 'Delete unnamed label 3');
  assert.equal(deleteLabelText('   ', 1), 'Delete unnamed label 1');
  assert.equal(deleteLabelText('Visa', 1, true), 'Confirm delete label Visa');
  assert.equal(deleteLabelText('', 2, true), 'Confirm delete unnamed label 2');
});

test('focusAfterDelete picks the next label, else the previous one, else none', () => {
  assert.equal(focusAfterDelete(0, 2), 0, 'the first of three deleted: the old second');
  assert.equal(focusAfterDelete(1, 2), 1, 'a middle one deleted: the next');
  assert.equal(focusAfterDelete(2, 2), 1, 'the last deleted: the previous');
  assert.equal(focusAfterDelete(0, 0), null, 'the only one deleted: nothing, so Add label');
});
