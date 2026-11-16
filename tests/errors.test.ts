import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerErrorText, rowFailureText, testResultText } from '../src/errors';

test('providerErrorText maps each status class to plain text', () => {
  assert.equal(providerErrorText(401), 'The provider rejected the API key. Replace it in the popup.');
  assert.equal(providerErrorText(403), 'The provider rejected the API key. Replace it in the popup.');
  assert.equal(providerErrorText(429), 'The provider is rate limiting requests. Try again in a minute.');
  assert.equal(providerErrorText(500), 'The provider is unavailable right now. Try again later.');
  assert.equal(providerErrorText(503), 'The provider is unavailable right now. Try again later.');
  assert.equal(providerErrorText(undefined), 'Could not reach the provider. Check your connection.');
  assert.equal(providerErrorText(400), 'The provider refused the request (status 400).');
  assert.equal(providerErrorText(404), 'The provider refused the request (status 404).');
});

test('rowFailureText prefers an auth failure, then the first status, and never shows the raw message', () => {
  const raw = 'secret provider detail';
  assert.equal(
    rowFailureText([{ message: raw, status: 429 }, undefined, { message: raw, status: 401 }]),
    providerErrorText(401)
  );
  assert.equal(rowFailureText([undefined, { message: raw, status: 503 }]), providerErrorText(503));
  assert.equal(rowFailureText([{ message: raw }]), providerErrorText(undefined));
  assert.equal(rowFailureText([]), providerErrorText(undefined));
  assert.ok(!rowFailureText([{ message: raw, status: 400 }]).includes(raw));
});

test('testResultText covers every test outcome', () => {
  assert.equal(testResultText({ ok: true }), 'Connected');
  assert.equal(
    testResultText({ ok: false, error: 'needs_ack' }),
    'Accept the first-run notice in the popup before testing.'
  );
  assert.equal(testResultText({ ok: false, error: 'missing_key' }), 'No API key saved.');
  assert.equal(testResultText({ ok: false, error: 'failed' }), 'Connection test failed.');
  assert.equal(testResultText({ ok: false, error: 'provider', status: 429 }), providerErrorText(429));
  assert.equal(testResultText({ ok: false, error: 'provider' }), providerErrorText(undefined));
});
