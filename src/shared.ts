export const VIEWS: readonly View[] = ['inbox', 'tabs', 'search', 'other'];

export type View = 'inbox' | 'tabs' | 'search' | 'other';

export type ViewSettingKey = 'viewInbox' | 'viewTabs' | 'viewSearch' | 'viewOther';

export const VIEW_SETTING_KEYS: Record<View, ViewSettingKey> = {
  inbox: 'viewInbox',
  tabs: 'viewTabs',
  search: 'viewSearch',
  other: 'viewOther',
};

export type Provider = 'gateway' | 'typesafe';

export function isProvider(value: unknown): value is Provider {
  return value === 'gateway' || value === 'typesafe';
}

export type Settings = {
  apiKey: string;
  apiKeyHint: string;
  typesafeApiKey: string;
  typesafeApiKeyHint: string;
  provider: Provider;
  enabled: boolean;
  threshold: number;
  privacyAck: boolean;
  classifyRead: boolean;
} & Record<ViewSettingKey, boolean>;

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  apiKeyHint: '',
  typesafeApiKey: '',
  typesafeApiKeyHint: '',
  provider: 'gateway',
  enabled: true,
  threshold: 0.7,
  privacyAck: false,
  classifyRead: false,
  viewInbox: true,
  viewTabs: true,
  viewSearch: false,
  viewOther: false,
};

export const POPUP_SETTING_KEYS = [
  'apiKeyHint',
  'typesafeApiKeyHint',
  'provider',
  'enabled',
  'threshold',
  'privacyAck',
  'labels',
  'classifyRead',
  ...VIEWS.map((view) => VIEW_SETTING_KEYS[view]),
] as const;

export const CONTENT_SETTING_KEYS = POPUP_SETTING_KEYS.filter(
  (key) => key !== 'apiKeyHint' && key !== 'typesafeApiKeyHint'
);

export type ContentSettingKey = (typeof CONTENT_SETTING_KEYS)[number];

export const CACHE_PREFIX = 'crit:';

const API_KEY_NAMES: readonly string[] = ['apiKey', 'typesafeApiKey'];

export type LabelConfig = { id: string; name: string; description: string };

export const MAX_LABELS = 15;

export const MAX_CLASSIFY_BATCH = 20;

export type EmailState = {
  threadId: string;
  legacyThreadId: string;
  lastMessageId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  date: string;
};

export type Classification = {
  criticalProbability: number;
  urgencyScore: number;
  labels: Record<string, number>;
};

export type ClassifyError = { message: string; status?: number };

export type ClassifyMessage = {
  type: 'classify';
  emails: EmailState[];
  labels: LabelConfig[];
};

export type ClassifyResult =
  | {
      ok: true;
      results: Record<string, Classification>;
      errors: Record<string, ClassifyError>;
    }
  | { ok: false; error: 'missing_key' | 'failed' | 'needs_ack' };

export type TestMessage = { type: 'test' };

export type StateMessage = { type: 'state' };

export type ContentState = {
  settings: Partial<Record<ContentSettingKey, unknown>>;
  cache: Record<string, Classification>;
};

export type StateResult = ({ ok: true } & ContentState) | { ok: false; error: 'failed' };

export type StorageChange = { newValue?: unknown; oldValue?: unknown };

export type ChangedMessage = {
  type: 'changed';
  keysChanged: boolean;
  changes: Record<string, StorageChange>;
};

export type TestResult =
  | { ok: true }
  | { ok: false; error: 'needs_ack' | 'missing_key' | 'failed' }
  | { ok: false; error: 'provider'; status?: number };

export function labelsHash(labels: LabelConfig[]): string {
  let h = 5381;
  for (const label of labels) {
    const s = `${label.id}|${label.name}|${label.description}`;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function threadKey(state: EmailState, version: string): string {
  return `${state.threadId}|${state.lastMessageId}|${version}`;
}

export function cacheVersion(labels: LabelConfig[], provider: Provider): string {
  return `${provider}:${labelsHash(labels)}`;
}

export function isEmailState(value: unknown): value is EmailState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.threadId === 'string' &&
    typeof v.legacyThreadId === 'string' &&
    typeof v.lastMessageId === 'string' &&
    typeof v.fromName === 'string' &&
    typeof v.fromEmail === 'string' &&
    typeof v.subject === 'string' &&
    typeof v.snippet === 'string' &&
    typeof v.date === 'string'
  );
}

export function isLabelConfig(value: unknown): value is LabelConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.description === 'string'
  );
}

export type LabelIssue = { name: boolean; description: boolean };

export function labelIssue(label: LabelConfig): LabelIssue | undefined {
  const name = label.name.trim().length === 0;
  const description = label.description.trim().length === 0;
  return name || description ? { name, description } : undefined;
}

export function labelIssueText(issue: LabelIssue): string {
  const missing =
    issue.name && issue.description ? 'a name and a description' : issue.name ? 'a name' : 'a description';
  return `Add ${missing} to save this label.`;
}

// Each complete label saves on its own. An incomplete edit of a saved label keeps its saved
// version until it is fixed; a new incomplete label is not saved yet. Ids never change.
export function labelsToSave(draft: LabelConfig[], saved: LabelConfig[]): LabelConfig[] {
  const next: LabelConfig[] = [];
  for (const label of draft) {
    if (labelIssue(label) === undefined) {
      next.push({ id: label.id, name: label.name.trim(), description: label.description.trim() });
      continue;
    }
    const previous = saved.find((item) => item.id === label.id);
    if (previous !== undefined) next.push(previous);
  }
  return next.slice(0, MAX_LABELS);
}

export function isClassification(value: unknown): value is Classification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.criticalProbability !== 'number') return false;
  if (typeof v.urgencyScore !== 'number') return false;
  const labels = v.labels;
  if (typeof labels !== 'object' || labels === null) return false;
  return Object.values(labels).every((probability) => typeof probability === 'number');
}

// What the manage page shows for a cached thread. Stored locally only, never sent anywhere.
export type ThreadMeta = { fromName: string; fromEmail: string; subject: string; date: string };

export type CacheEntry = Classification & { ts: number; thread: ThreadMeta };

const META_LIMITS: Record<keyof ThreadMeta, number> = {
  fromName: 100,
  fromEmail: 254,
  subject: 200,
  date: 60,
};

export function cacheEntry(classification: Classification, email: EmailState, ts: number): CacheEntry {
  return {
    criticalProbability: classification.criticalProbability,
    urgencyScore: classification.urgencyScore,
    labels: classification.labels,
    ts,
    thread: {
      fromName: email.fromName.slice(0, META_LIMITS.fromName),
      fromEmail: email.fromEmail.slice(0, META_LIMITS.fromEmail),
      subject: email.subject.slice(0, META_LIMITS.subject),
      date: email.date.slice(0, META_LIMITS.date),
    },
  };
}

export function classificationOf(value: unknown): Classification | undefined {
  if (!isClassification(value)) return undefined;
  return {
    criticalProbability: value.criticalProbability,
    urgencyScore: value.urgencyScore,
    labels: value.labels,
  };
}

export function threadMetaOf(value: unknown): ThreadMeta | undefined {
  if (typeof value !== 'object' || value === null || !('thread' in value)) return undefined;
  const thread: unknown = value.thread;
  if (typeof thread !== 'object' || thread === null) return undefined;
  const t = thread as Record<string, unknown>;
  if (
    typeof t.fromName !== 'string' ||
    typeof t.fromEmail !== 'string' ||
    typeof t.subject !== 'string' ||
    typeof t.date !== 'string'
  ) {
    return undefined;
  }
  return { fromName: t.fromName, fromEmail: t.fromEmail, subject: t.subject, date: t.date };
}

function isContentSettingKey(key: string): key is ContentSettingKey {
  return (CONTENT_SETTING_KEYS as readonly string[]).includes(key);
}

export function contentState(stored: Record<string, unknown>): ContentState {
  const settings: Partial<Record<ContentSettingKey, unknown>> = {};
  for (const key of CONTENT_SETTING_KEYS) {
    if (key in stored) settings[key] = stored[key];
  }
  const labels = Array.isArray(stored.labels) ? stored.labels.filter(isLabelConfig) : [];
  const provider = isProvider(stored.provider) ? stored.provider : DEFAULT_SETTINGS.provider;
  const version = cacheVersion(labels, provider);
  const cache: Record<string, Classification> = {};
  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(CACHE_PREFIX)) continue;
    const cacheKey = storageKey.slice(CACHE_PREFIX.length);
    if (!cacheKey.endsWith(`|${version}`)) continue;
    const classification = classificationOf(value);
    if (classification !== undefined) cache[cacheKey] = classification;
  }
  return { settings, cache };
}

export function contentChanges(
  changes: Record<string, StorageChange>
): ChangedMessage | undefined {
  let keysChanged = false;
  const forwarded: Record<string, StorageChange> = {};
  for (const [key, change] of Object.entries(changes)) {
    if (API_KEY_NAMES.includes(key)) {
      keysChanged = true;
      continue;
    }
    if (!isContentSettingKey(key) && !key.startsWith(CACHE_PREFIX)) continue;
    if (!('newValue' in change)) {
      forwarded[key] = {};
      continue;
    }
    // A cache entry also holds the thread's sender and subject; the content script needs only the scores.
    const newValue = key.startsWith(CACHE_PREFIX)
      ? (classificationOf(change.newValue) ?? change.newValue)
      : change.newValue;
    forwarded[key] = { newValue };
  }
  if (!keysChanged && Object.keys(forwarded).length === 0) return undefined;
  return { type: 'changed', keysChanged, changes: forwarded };
}

export function isContentState(value: unknown): value is ContentState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.settings === 'object' &&
    v.settings !== null &&
    typeof v.cache === 'object' &&
    v.cache !== null
  );
}

export function isChangedMessage(value: unknown): value is ChangedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== 'changed' || typeof v.keysChanged !== 'boolean') return false;
  const changes = v.changes;
  if (typeof changes !== 'object' || changes === null) return false;
  return Object.values(changes).every((change) => typeof change === 'object' && change !== null);
}

const THREAD_ID = /^[A-Za-z0-9]{16,}$/;

const TWO_SEGMENT_LIST_HEADS: Record<string, true> = {
  search: true,
  'advanced-search': true,
  label: true,
  category: true,
};

function parseHash(hash: string): { raw: string[]; decoded: string[] } {
  const raw = hash
    .replace(/^#/, '')
    .split('?')[0]
    .split('/')
    .filter((part) => part.length > 0);
  const decoded = raw.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return { raw, decoded };
}

function threadIndex(parts: string[]): number {
  const last = parts.length - 1;
  if (last < 1 || !THREAD_ID.test(parts[last])) return -1;
  if (TWO_SEGMENT_LIST_HEADS[parts[0]] === true) return parts.length >= 3 ? last : -1;
  return last;
}

export function viewFromHash(hash: string): View | null {
  const { decoded } = parseHash(hash);
  if (decoded.length === 0) return 'inbox';
  if (threadIndex(decoded) !== -1) return null;
  const head = decoded[0];
  if (head === 'inbox') return 'inbox';
  if (head === 'category') return 'tabs';
  if (head === 'search' || head === 'advanced-search') return 'search';
  return 'other';
}

export function routeKey(hash: string): string {
  const queryAt = hash.indexOf('?');
  const query = queryAt === -1 ? '' : hash.slice(queryAt + 1);
  const { decoded } = parseHash(hash);
  const index = threadIndex(decoded);
  const parts = index === -1 ? decoded : decoded.slice(0, index);
  const route = parts.length === 0 ? 'inbox' : parts.join('/');
  return query.length === 0 ? route : `${route}?${query}`;
}
