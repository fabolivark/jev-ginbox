import type { ClassifyError, TestResult } from './shared';

export function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

// The one place a provider failure becomes user-facing text. The provider's own message is never shown.
export function providerErrorText(status: number | undefined): string {
  if (status === undefined) return 'Could not reach the provider. Check your connection.';
  if (isAuthStatus(status)) return 'The provider rejected the API key. Replace it in the popup.';
  if (status === 429) return 'The provider is rate limiting requests. Try again in a minute.';
  if (status >= 500) return 'The provider is unavailable right now. Try again later.';
  return `The provider refused the request (status ${status}).`;
}

export function rowFailureText(failures: readonly (ClassifyError | undefined)[]): string {
  const known = failures.filter((failure): failure is ClassifyError => failure !== undefined);
  const auth = known.find((failure) => isAuthStatus(failure.status));
  const withStatus = known.find((failure) => failure.status !== undefined);
  return providerErrorText((auth ?? withStatus)?.status);
}

export function testResultText(result: TestResult): string {
  if (result.ok) return 'Connected';
  if (result.error === 'provider') return providerErrorText(result.status);
  if (result.error === 'needs_ack') return 'Accept the first-run notice in the popup before testing.';
  return 'No API key saved.';
}
