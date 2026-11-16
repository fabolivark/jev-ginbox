import { isProvider, type Provider } from './shared';

export type PendingRow = 'loading' | 'retrying' | 'none';

export function pendingRow(failureCount: number, halted: boolean): PendingRow {
  if (halted) return 'none';
  return failureCount > 0 ? 'retrying' : 'loading';
}

export type PopupStatus = {
  enabled: boolean;
  acknowledged: boolean;
  hasKey: boolean;
  keyRejected: boolean;
  onGmail: boolean;
};

export function popupStatusText(status: PopupStatus): string {
  if (!status.enabled) return 'Paused';
  if (!status.acknowledged) return 'Accept the notice below to start';
  if (!status.hasKey) return 'Add a key to start';
  if (status.keyRejected) return 'The key was rejected. Replace it below.';
  if (!status.onGmail) return 'Ready. Open Gmail to use it.';
  return 'Active on this Gmail tab';
}

export function isGmailUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'mail.google.com';
  } catch {
    return false;
  }
}

export function canTestConnection(acknowledged: boolean, hasSavedKey: boolean, typed: string): boolean {
  return acknowledged && (hasSavedKey || typed.trim().length > 0);
}

export function testHintText(acknowledged: boolean, hasKey: boolean): string | null {
  if (!acknowledged) return 'Accept the notice above before testing the key.';
  if (!hasKey) return 'Paste a key above to test it.';
  return null;
}

export function isAuthRejection(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

export type AuthOutcome = 'accepted' | 'rejected' | 'other';

// The new `authFailed` value: a provider to store, null to remove it, undefined to leave it.
export function nextAuthFailed(
  current: unknown,
  provider: Provider,
  outcome: AuthOutcome
): Provider | null | undefined {
  const stored = isProvider(current) ? current : undefined;
  if (outcome === 'rejected') return stored === provider ? undefined : provider;
  if (outcome === 'accepted' && stored === provider) return null;
  return undefined;
}
