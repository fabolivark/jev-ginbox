import {
  CACHE_PREFIX,
  DEFAULT_SETTINGS,
  cacheVersion,
  classificationOf,
  isLabelConfig,
  isProvider,
  threadMetaOf,
  type LabelConfig,
  type ThreadMeta,
} from './shared';

// Google documents no limit for a Gmail search. 1500 characters is the known limit of a
// Gmail filter's criteria; it has not been measured live against the search box.
export const GMAIL_QUERY_MAX = 1500;

export const ALL_LABELS = 'all';
export const NO_LABEL = 'none';
export const URGENCY_MIN = 0;
export const URGENCY_MAX = 3;

export type TriageThread = ThreadMeta & {
  key: string;
  labelId: string | null;
  urgency: number;
  critical: boolean;
  ts: number;
};

export type TriageData = { threads: TriageThread[]; missing: number };

export type TriageFilter = { label: string; minUrgency: number; maxUrgency: number; text: string };

export type SenderGroup = {
  email: string;
  name: string;
  count: number;
  latestSubject: string;
  latestDate: string;
  latestTs: number;
};

export type LabelGroup = { id: string | null; name: string; count: number; senders: SenderGroup[] };

export function storedLabels(stored: Record<string, unknown>): LabelConfig[] {
  return Array.isArray(stored.labels) ? stored.labels.filter(isLabelConfig) : [];
}

// Reads the cache entries of the current labels and provider. Entries written before the
// cache kept a sender, or without a sender address, are counted in `missing`.
export function triageThreads(stored: Record<string, unknown>): TriageData {
  const labels = storedLabels(stored);
  const provider = isProvider(stored.provider) ? stored.provider : DEFAULT_SETTINGS.provider;
  const threshold = typeof stored.threshold === 'number' ? stored.threshold : DEFAULT_SETTINGS.threshold;
  const suffix = `|${cacheVersion(labels, provider)}`;
  const threads: TriageThread[] = [];
  let missing = 0;
  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(CACHE_PREFIX) || !storageKey.endsWith(suffix)) continue;
    const classification = classificationOf(value);
    if (classification === undefined) continue;
    const meta = threadMetaOf(value);
    if (meta === undefined || meta.fromEmail.length === 0) {
      missing += 1;
      continue;
    }
    let labelId: string | null = null;
    let best = threshold;
    for (const label of labels) {
      const probability = classification.labels[label.id];
      if (probability === undefined || probability < threshold) continue;
      if (labelId === null || probability > best) {
        labelId = label.id;
        best = probability;
      }
    }
    const ts = typeof value === 'object' && value !== null && 'ts' in value && typeof value.ts === 'number' ? value.ts : 0;
    threads.push({
      ...meta,
      key: storageKey.slice(CACHE_PREFIX.length, -suffix.length),
      labelId,
      urgency: classification.urgencyScore,
      critical: classification.criticalProbability >= threshold,
      ts,
    });
  }
  return { threads, missing };
}

export function filterThreads(threads: TriageThread[], filter: TriageFilter): TriageThread[] {
  const text = filter.text.trim().toLowerCase();
  return threads.filter((thread) => {
    if (filter.label === NO_LABEL && thread.labelId !== null) return false;
    if (filter.label !== ALL_LABELS && filter.label !== NO_LABEL && thread.labelId !== filter.label) return false;
    if (thread.urgency < filter.minUrgency || thread.urgency > filter.maxUrgency) return false;
    if (text.length === 0) return true;
    return [thread.fromName, thread.fromEmail, thread.subject].some((field) =>
      field.toLowerCase().includes(text)
    );
  });
}

export function senderKey(email: string): string {
  return email.trim().toLowerCase();
}

export function groupThreads(threads: TriageThread[], labels: LabelConfig[]): LabelGroup[] {
  const order: { id: string | null; name: string }[] = [
    ...labels.map((label) => ({ id: label.id, name: label.name })),
    { id: null, name: 'No label' },
  ];
  const groups: LabelGroup[] = [];
  for (const { id, name } of order) {
    const members = threads.filter((thread) => thread.labelId === id);
    if (members.length === 0) continue;
    const senders = new Map<string, SenderGroup>();
    for (const thread of members) {
      const email = senderKey(thread.fromEmail);
      const current = senders.get(email);
      if (current === undefined) {
        senders.set(email, {
          email,
          name: thread.fromName,
          count: 1,
          latestSubject: thread.subject,
          latestDate: thread.date,
          latestTs: thread.ts,
        });
        continue;
      }
      current.count += 1;
      if (thread.ts >= current.latestTs) {
        current.latestTs = thread.ts;
        current.latestSubject = thread.subject;
        current.latestDate = thread.date;
        if (thread.fromName.length > 0) current.name = thread.fromName;
      }
    }
    const sorted = [...senders.values()].sort(
      (a, b) => b.count - a.count || b.latestTs - a.latestTs || a.email.localeCompare(b.email)
    );
    groups.push({ id, name, count: members.length, senders: sorted });
  }
  return groups;
}

// A bare address token in a Gmail query: no spaces, quotes, parentheses or braces that
// would change the query, and no leading minus that Gmail reads as "not".
const SEARCHABLE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`|~][A-Za-z0-9.!#$%&'*+/=?^_`|~-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

export function isSearchableEmail(email: string): boolean {
  return email.length <= 254 && SEARCHABLE_EMAIL.test(email);
}

export type QueryOptions = { inboxOnly: boolean; maxLength?: number };

// One Gmail search per chunk of senders, e.g. `in:inbox from:(a@x.com OR b@y.com)`,
// split so no search passes `maxLength` characters.
export function senderQueries(emails: string[], options: QueryOptions): string[] {
  const maxLength = options.maxLength ?? GMAIL_QUERY_MAX;
  const prefix = options.inboxOnly ? 'in:inbox from:(' : 'from:(';
  const unique = [...new Set(emails.map(senderKey))].filter(isSearchableEmail);
  const queries: string[] = [];
  let chunk: string[] = [];
  const build = (parts: string[]): string => `${prefix}${parts.join(' OR ')})`;
  for (const email of unique) {
    if (chunk.length > 0 && build([...chunk, email]).length > maxLength) {
      queries.push(build(chunk));
      chunk = [];
    }
    chunk.push(email);
  }
  if (chunk.length > 0) queries.push(build(chunk));
  return queries;
}

export function gmailSearchUrl(query: string, account: number): string {
  return `https://mail.google.com/mail/u/${account}/#search/${encodeURIComponent(query)}`;
}

const GMAIL_ACCOUNT_URL = /^https:\/\/mail\.google\.com\/mail\/u\/(\d+)\//;

export function gmailAccounts(urls: (string | undefined)[]): number[] {
  const found = new Set<number>();
  for (const url of urls) {
    const match = url === undefined ? null : GMAIL_ACCOUNT_URL.exec(url);
    if (match?.[1] !== undefined) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}
