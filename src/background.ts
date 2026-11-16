import { classifyEmail, testConnection } from './jev';
import { parseRequest } from './requests';
import {
  CACHE_PREFIX,
  cacheVersion,
  contentChanges,
  contentState,
  isClassification,
  isProvider,
  threadKey,
  type ClassifyError,
  type ClassifyResult,
  type Classification,
  type EmailState,
  type LabelConfig,
  type Provider,
  type StateResult,
  type TestResult,
} from './shared';
import { isAuthRejection, nextAuthFailed, type AuthOutcome } from './status';

const CONCURRENCY = 8;
const CACHE_MAX = 5000;
const CACHE_KEEP = 4000;

const inflight = new Map<string, Promise<Classification>>();

const GMAIL_TABS = 'https://mail.google.com/*';

void chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch((error: unknown) => {
    console.error('storage access level failed', error);
  });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const message = contentChanges(changes);
  if (message === undefined) return;
  void chrome.tabs.query({ url: GMAIL_TABS }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handle(message, sender).then(sendResponse, (err: unknown) => {
    console.error('classify failed', err);
    sendResponse({ ok: false, error: 'failed' } satisfies ClassifyResult);
  });
  return true;
});

async function handle(
  message: unknown,
  sender: chrome.runtime.MessageSender
): Promise<ClassifyResult | StateResult | TestResult> {
  const parsed = parseRequest(message, sender, chrome.runtime.id);
  if (parsed === undefined) return { ok: false, error: 'failed' } satisfies ClassifyResult;
  if (parsed.type === 'state') {
    const stored = await chrome.storage.local.get(null);
    return { ok: true, ...contentState(stored) } satisfies StateResult;
  }
  const test = parsed.type === 'test';
  const request = parsed.type === 'classify' ? parsed : undefined;

  const {
    provider: storedProvider,
    apiKey,
    typesafeApiKey,
    privacyAck,
    authFailed,
  } = await chrome.storage.local.get([
    'provider',
    'apiKey',
    'typesafeApiKey',
    'privacyAck',
    'authFailed',
  ]);
  const provider = isProvider(storedProvider) ? storedProvider : 'gateway';
  const key = provider === 'typesafe' ? typesafeApiKey : apiKey;
  if (test) {
    if (privacyAck !== true) return { ok: false, error: 'needs_ack' } satisfies TestResult;
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'missing_key' } satisfies TestResult;
    }
    try {
      await testConnection(key, provider);
      await recordAuth(authFailed, provider, 'accepted');
      return { ok: true } satisfies TestResult;
    } catch (error) {
      const { status } = toClassifyError(error);
      await recordAuth(authFailed, provider, isAuthRejection(status) ? 'rejected' : 'other');
      return {
        ok: false,
        error: 'provider',
        ...(status === undefined ? {} : { status }),
      } satisfies TestResult;
    }
  }
  if (request === undefined) return { ok: false, error: 'failed' } satisfies ClassifyResult;
  const { emails, labels } = request;
  if (privacyAck !== true) return { ok: false, error: 'needs_ack' } satisfies ClassifyResult;
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, error: 'missing_key' } satisfies ClassifyResult;
  }

  const version = cacheVersion(labels, provider);
  const tasks = new Map<string, { email: EmailState; key: string; storeKey: string }>();
  for (const email of emails) {
    const key = threadKey(email, version);
    tasks.set(key, { email, key, storeKey: `${CACHE_PREFIX}${key}` });
  }
  const stored = await chrome.storage.local.get([...tasks.values()].map((t) => t.storeKey));
  const results: Record<string, Classification> = {};
  for (const task of tasks.values()) {
    const hit = stored[task.storeKey];
    if (isClassification(hit)) results[task.key] = hit;
  }
  const fresh = [...tasks.values()].filter((task) => results[task.key] === undefined);

  const queue = [...fresh];
  const errors: Record<string, ClassifyError> = {};
  let authAborted = false;
  let accepted = false;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      if (authAborted) return;
      const task = queue.shift();
      if (task === undefined) return;
      try {
        results[task.key] = await classifyWithCache(task.storeKey, task.email, key, labels, provider);
        accepted = true;
      } catch (error) {
        const failure = toClassifyError(error);
        errors[task.key] = failure;
        if (isAuthRejection(failure.status)) {
          authAborted = true;
          return;
        }
      }
    }
  });
  await Promise.all(workers);
  if (authAborted) await recordAuth(authFailed, provider, 'rejected');
  else if (accepted) await recordAuth(authFailed, provider, 'accepted');
  if (fresh.length > 0) await pruneCache();
  return { ok: true, results, errors };
}

// `authFailed` names the provider whose last call was rejected; only the popup reads it.
async function recordAuth(current: unknown, provider: Provider, outcome: AuthOutcome): Promise<void> {
  const next = nextAuthFailed(current, provider, outcome);
  if (next === undefined) return;
  try {
    if (next === null) await chrome.storage.local.remove('authFailed');
    else await chrome.storage.local.set({ authFailed: next });
  } catch (error) {
    console.error('auth state write failed', error);
  }
}

function classifyWithCache(
  storeKey: string,
  email: EmailState,
  apiKey: string,
  labels: LabelConfig[],
  provider: Provider
): Promise<Classification> {
  const existing = inflight.get(storeKey);
  if (existing !== undefined) return existing;
  const promise = resolveClassification(storeKey, email, apiKey, labels, provider).finally(() => {
    inflight.delete(storeKey);
  });
  inflight.set(storeKey, promise);
  return promise;
}

async function resolveClassification(
  storeKey: string,
  email: EmailState,
  apiKey: string,
  labels: LabelConfig[],
  provider: Provider
): Promise<Classification> {
  const stored = await chrome.storage.local.get(storeKey);
  const hit = stored[storeKey];
  if (isClassification(hit)) return hit;
  const classification = await classifyEmail(email, apiKey, labels, provider);
  try {
    await chrome.storage.local.set({ [storeKey]: { ...classification, ts: Date.now() } });
  } catch (error) {
    console.error('cache write failed', error);
  }
  return classification;
}

async function pruneCache(): Promise<void> {
  if (typeof chrome.storage.local.getKeys !== 'function') return;
  try {
    const keys = (await chrome.storage.local.getKeys()).filter((key) =>
      key.startsWith(CACHE_PREFIX)
    );
    if (keys.length <= CACHE_MAX) return;
    const stored = await chrome.storage.local.get(keys);
    const ranked = keys
      .map((key) => {
        const entry: unknown = stored[key];
        const ts =
          typeof entry === 'object' &&
          entry !== null &&
          'ts' in entry &&
          typeof entry.ts === 'number'
            ? entry.ts
            : 0;
        return { key, ts };
      })
      .sort((a, b) => a.ts - b.ts);
    const excess = keys.length - CACHE_KEEP;
    await chrome.storage.local.remove(ranked.slice(0, excess).map((item) => item.key));
  } catch (error) {
    console.error('cache prune failed', error);
  }
}

function toClassifyError(error: unknown): ClassifyError {
  const raw = error instanceof Error ? error.message : String(error);
  const failure: ClassifyError = {
    message: (raw || 'Classification failed').slice(0, 160),
  };
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const code = error.statusCode;
    if (typeof code === 'number') failure.status = code;
  }
  return failure;
}
