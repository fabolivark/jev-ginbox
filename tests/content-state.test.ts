import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import {
  cacheVersion,
  contentChanges,
  contentState,
  isChangedMessage,
  isContentState,
  type Classification,
  type LabelConfig,
} from '../src/shared';

const labels: LabelConfig[] = [{ id: 'money', name: 'Money', description: 'Invoices' }];
const version = cacheVersion(labels, 'typesafe');
const hit: Classification = { criticalProbability: 0.9, urgencyScore: 3, labels: { money: 0.8 } };

const stored: Record<string, unknown> = {
  apiKey: 'vck_secret_gateway',
  apiKeyHint: 'eway',
  typesafeApiKey: 'ts_secret',
  typesafeApiKeyHint: 'cret',
  provider: 'typesafe',
  enabled: true,
  threshold: 0.6,
  privacyAck: true,
  labels,
  viewInbox: true,
  viewSearch: false,
  [`crit:t1|m1|${version}`]: { ...hit, ts: 1 },
  [`crit:t2|m2|gateway:old`]: hit,
  [`crit:t3|m3|${version}`]: { broken: true },
};

test('contentState returns the content settings and never a key or hint', () => {
  const state = contentState(stored);
  assert.deepEqual(state.settings, {
    provider: 'typesafe',
    enabled: true,
    threshold: 0.6,
    privacyAck: true,
    labels,
    viewInbox: true,
    viewSearch: false,
  });
  const serialized = JSON.stringify(state);
  for (const secret of ['vck_secret_gateway', 'ts_secret', 'eway', 'cret']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('contentState returns only valid cache entries of the current version', () => {
  const state = contentState(stored);
  assert.deepEqual(Object.keys(state.cache), [`t1|m1|${version}`]);
  assert.equal(state.cache[`t1|m1|${version}`]?.criticalProbability, 0.9);
});

test('contentChanges forwards settings and cache changes', () => {
  const message = contentChanges({
    threshold: { newValue: 0.5 },
    [`crit:t1|m1|${version}`]: { newValue: hit },
    [`crit:t2|m2|${version}`]: {},
  });
  assert.deepEqual(message, {
    type: 'changed',
    keysChanged: false,
    changes: {
      threshold: { newValue: 0.5 },
      [`crit:t1|m1|${version}`]: { newValue: hit },
      [`crit:t2|m2|${version}`]: {},
    },
  });
});

test('contentChanges reports a key change without its value', () => {
  const message = contentChanges({
    apiKey: { newValue: 'vck_secret_gateway', oldValue: 'vck_old' },
    apiKeyHint: { newValue: 'eway' },
  });
  assert.deepEqual(message, { type: 'changed', keysChanged: true, changes: {} });
  const typesafe = contentChanges({ typesafeApiKey: { oldValue: 'ts_secret' } });
  assert.equal(typesafe?.keysChanged, true);
  assert.equal(JSON.stringify(typesafe).includes('ts_secret'), false);
});

test('contentChanges ignores changes the content script does not use', () => {
  assert.equal(contentChanges({ apiKeyHint: { newValue: 'eway' } }), undefined);
});

test('isChangedMessage accepts what contentChanges builds and rejects the rest', () => {
  assert.equal(isChangedMessage(contentChanges({ enabled: { newValue: false } })), true);
  assert.equal(isChangedMessage({ type: 'changed', changes: {} }), false);
  assert.equal(isChangedMessage({ type: 'changed', keysChanged: false, changes: { a: 1 } }), false);
  assert.equal(isChangedMessage({ type: 'classify' }), false);
});

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return result.outputFiles.map((file) => file.text).join('');
}

test('the content script bundle never touches chrome.storage', async () => {
  const code = await bundle('src/content.ts');
  assert.equal(code.includes('chrome.storage'), false);
});

test('the service worker restricts storage to trusted contexts', async () => {
  const code = await bundle('src/background.ts');
  assert.match(code, /setAccessLevel\(\{\s*accessLevel:\s*"TRUSTED_CONTEXTS"/);
});

test('isContentState accepts a state reply and rejects a failure', () => {
  assert.equal(isContentState({ ok: true, ...contentState(stored) }), true);
  assert.equal(isContentState({ ok: false, error: 'failed' }), false);
  assert.equal(isContentState(undefined), false);
});
