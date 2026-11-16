import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SETUP_PAGE,
  isSetupPage,
  opensSetupOnInstall,
  setupBadge,
  touchesSetup,
} from '../src/setup';

const DONE = { text: '', title: 'Jev Inbox' };
const TODO = { text: '!', title: 'Jev Inbox: finish setup' };

test('the badge asks to finish setup until the notice is accepted', () => {
  assert.deepEqual(setupBadge({}, false), TODO);
  assert.deepEqual(setupBadge({ apiKey: 'k' }, false), TODO);
  assert.deepEqual(setupBadge({ privacyAck: 'yes', apiKey: 'k' }, false), TODO);
  assert.deepEqual(setupBadge({ privacyAck: true, apiKey: 'k' }, false), DONE);
});

test('the badge asks for the key of the selected provider', () => {
  assert.deepEqual(setupBadge({ privacyAck: true }, false), TODO);
  assert.deepEqual(setupBadge({ privacyAck: true, apiKey: '' }, false), TODO);
  assert.deepEqual(setupBadge({ privacyAck: true, typesafeApiKey: 'k' }, false), TODO);
  assert.deepEqual(
    setupBadge({ privacyAck: true, provider: 'typesafe', typesafeApiKey: 'k' }, false),
    DONE
  );
  assert.deepEqual(setupBadge({ privacyAck: true, provider: 'typesafe', apiKey: 'k' }, false), TODO);
  assert.deepEqual(setupBadge({ privacyAck: true, provider: 'bogus', apiKey: 'k' }, false), DONE);
});

test('the badge asks to finish setup after a 401 or 403', () => {
  assert.deepEqual(setupBadge({ privacyAck: true, apiKey: 'k' }, true), TODO);
});

test('only a fresh install opens the setup tab', () => {
  assert.equal(opensSetupOnInstall('install'), true);
  assert.equal(opensSetupOnInstall('update'), false);
  assert.equal(opensSetupOnInstall('chrome_update'), false);
  assert.equal(opensSetupOnInstall('shared_module_update'), false);
});

test('the setup tab is the popup page with setup=1', () => {
  assert.equal(SETUP_PAGE, 'popup.html?setup=1');
  assert.equal(isSetupPage('?setup=1'), true);
  assert.equal(isSetupPage(new URL(`chrome-extension://id/${SETUP_PAGE}`).search), true);
  assert.equal(isSetupPage(''), false);
  assert.equal(isSetupPage('?setup=0'), false);
});

test('the badge is recomputed only when a setup key changes', () => {
  for (const key of ['privacyAck', 'provider', 'apiKey', 'typesafeApiKey']) {
    assert.equal(touchesSetup([key]), true, key);
  }
  assert.equal(touchesSetup(['threshold', 'crit:abc']), false);
  assert.equal(touchesSetup([]), false);
});
