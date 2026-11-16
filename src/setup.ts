import { isProvider } from './shared';

// The setup tab is the popup page itself, opened in a tab, so there is one source of truth.
export const SETUP_PAGE = 'popup.html?setup=1';

export const SETUP_KEYS = ['privacyAck', 'provider', 'apiKey', 'typesafeApiKey'] as const;

export type Badge = { text: string; title: string };

export type OpenSetupResult = { ok: true };

const TITLE = 'Jev Inbox';

export function setupBadge(stored: Record<string, unknown>, authFailed: boolean): Badge {
  const provider = isProvider(stored.provider) ? stored.provider : 'gateway';
  const key = provider === 'typesafe' ? stored.typesafeApiKey : stored.apiKey;
  const done =
    stored.privacyAck === true && typeof key === 'string' && key.length > 0 && !authFailed;
  return done ? { text: '', title: TITLE } : { text: '!', title: `${TITLE}: finish setup` };
}

export function opensSetupOnInstall(reason: string): boolean {
  return reason === 'install';
}

export function isSetupPage(search: string): boolean {
  return new URLSearchParams(search).get('setup') === '1';
}

export function touchesSetup(changedKeys: readonly string[]): boolean {
  return changedKeys.some((key) => (SETUP_KEYS as readonly string[]).includes(key));
}
