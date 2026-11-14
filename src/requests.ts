import {
  MAX_CLASSIFY_BATCH,
  MAX_LABELS,
  isEmailState,
  isLabelConfig,
  type ClassifyMessage,
  type TestMessage,
} from './shared';

export type Request = ClassifyMessage | TestMessage;

const GMAIL_ORIGIN = 'https://mail.google.com';

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

function fromGmail(sender: chrome.runtime.MessageSender, runtimeId: string): boolean {
  return (
    sender.id === runtimeId &&
    sender.tab !== undefined &&
    originOf(sender.url) === GMAIL_ORIGIN
  );
}

function fromExtensionPage(sender: chrome.runtime.MessageSender, runtimeId: string): boolean {
  return (
    sender.id === runtimeId &&
    sender.tab === undefined &&
    originOf(sender.url) === `chrome-extension://${runtimeId}`
  );
}

function classifyRequest(value: object): ClassifyMessage | undefined {
  if (!('emails' in value) || !Array.isArray(value.emails)) return undefined;
  if (!('labels' in value) || !Array.isArray(value.labels)) return undefined;
  if (value.emails.length > MAX_CLASSIFY_BATCH) return undefined;
  if (value.labels.length > MAX_LABELS) return undefined;
  const emails = value.emails.filter(isEmailState);
  const labels = value.labels.filter(isLabelConfig);
  if (emails.length !== value.emails.length) return undefined;
  if (labels.length !== value.labels.length) return undefined;
  return { type: 'classify', emails, labels };
}

export function parseRequest(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  runtimeId: string
): Request | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined;
  if (value.type === 'classify') {
    return fromGmail(sender, runtimeId) ? classifyRequest(value) : undefined;
  }
  if (value.type === 'test') {
    return fromExtensionPage(sender, runtimeId) ? { type: 'test' } : undefined;
  }
  return undefined;
}
