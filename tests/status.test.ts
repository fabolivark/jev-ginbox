import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canTestConnection,
  isAuthRejection,
  isGmailUrl,
  nextAuthFailed,
  pendingRow,
  popupStatusText,
  testHintText,
  type PopupStatus,
} from '../src/status';

test('a halted row shows no marker, whatever its failure count', () => {
  assert.equal(pendingRow(0, true), 'none');
  assert.equal(pendingRow(3, true), 'none');
});

test('a row retries only after a failure while not halted', () => {
  assert.equal(pendingRow(0, false), 'loading');
  assert.equal(pendingRow(1, false), 'retrying');
});

const ready: PopupStatus = {
  enabled: true,
  acknowledged: true,
  hasKey: true,
  keyRejected: false,
  onGmail: true,
};

test('the popup status line follows the setup in priority order', () => {
  assert.equal(popupStatusText(ready), 'Active on this Gmail tab');
  assert.equal(popupStatusText({ ...ready, onGmail: false }), 'Ready. Open Gmail to use it.');
  assert.equal(
    popupStatusText({ ...ready, keyRejected: true, onGmail: false }),
    'The key was rejected. Replace it below.'
  );
  assert.equal(
    popupStatusText({ ...ready, hasKey: false, keyRejected: true }),
    'Add a key to start'
  );
  assert.equal(
    popupStatusText({ ...ready, acknowledged: false, hasKey: false }),
    'Accept the notice below to start'
  );
  assert.equal(popupStatusText({ ...ready, enabled: false, acknowledged: false }), 'Paused');
});

test('only an https mail.google.com url counts as Gmail', () => {
  assert.equal(isGmailUrl('https://mail.google.com/mail/u/0/#inbox'), true);
  assert.equal(isGmailUrl(undefined), false);
  assert.equal(isGmailUrl('https://www.google.com/'), false);
  assert.equal(isGmailUrl('http://mail.google.com/mail/u/0/'), false);
  assert.equal(isGmailUrl('https://mail.google.com.example.com/'), false);
  assert.equal(isGmailUrl('chrome-extension://abc/popup.html'), false);
  assert.equal(isGmailUrl('not a url'), false);
});

test('Test connection needs the notice and a saved or typed key', () => {
  assert.equal(canTestConnection(false, true, ''), false);
  assert.equal(canTestConnection(true, false, ''), false);
  assert.equal(canTestConnection(true, false, '   '), false);
  assert.equal(canTestConnection(true, false, 'vck_typed'), true);
  assert.equal(canTestConnection(true, true, ''), true);
});

test('the test hint names what is missing', () => {
  assert.equal(testHintText(false, false), 'Accept the notice above before testing the key.');
  assert.equal(testHintText(true, false), 'Paste a key above to test it.');
  assert.equal(testHintText(true, true), null);
});

test('only 401 and 403 count as a rejected key', () => {
  assert.equal(isAuthRejection(401), true);
  assert.equal(isAuthRejection(403), true);
  assert.equal(isAuthRejection(400), false);
  assert.equal(isAuthRejection(429), false);
  assert.equal(isAuthRejection(undefined), false);
});

test('the stored auth failure follows the last call for its provider', () => {
  assert.equal(nextAuthFailed(undefined, 'gateway', 'rejected'), 'gateway');
  assert.equal(nextAuthFailed('typesafe', 'gateway', 'rejected'), 'gateway');
  assert.equal(nextAuthFailed('gateway', 'gateway', 'rejected'), undefined);
  assert.equal(nextAuthFailed('gateway', 'gateway', 'accepted'), null);
  assert.equal(nextAuthFailed('typesafe', 'gateway', 'accepted'), undefined);
  assert.equal(nextAuthFailed(undefined, 'gateway', 'accepted'), undefined);
  assert.equal(nextAuthFailed('gateway', 'gateway', 'other'), undefined);
});
