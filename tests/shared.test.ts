import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, routeKey, viewFromHash } from '../src/shared';

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
