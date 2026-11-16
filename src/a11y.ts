/** The accessible name of a label's trash button, armed or not, from the name typed so far. */
export function deleteLabelText(name: string, position: number, confirming = false): string {
  const trimmed = name.trim();
  const target = trimmed.length > 0 ? `label ${trimmed}` : `unnamed label ${position}`;
  return `${confirming ? 'Confirm delete' : 'Delete'} ${target}`;
}

/** The index of the label whose name field takes focus after a delete, or null for Add label. */
export function focusAfterDelete(deleted: number, remaining: number): number | null {
  if (remaining === 0) return null;
  return Math.min(deleted, remaining - 1);
}
