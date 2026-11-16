import { routeKey, type Classification, type LabelConfig } from './shared';

export type RowFilter = { kind: 'critical' } | { kind: 'label'; id: string };

export type FilterOption = {
  token: string;
  name: string;
  count: number;
  hue: number | null;
};

const CRITICAL_TOKEN = 'critical';
const LABEL_PREFIX = 'label:';

export function filterToken(filter: RowFilter): string {
  return filter.kind === 'critical' ? CRITICAL_TOKEN : `${LABEL_PREFIX}${filter.id}`;
}

export function parseFilterToken(
  token: string | undefined,
  labels: LabelConfig[]
): RowFilter | null {
  if (token === CRITICAL_TOKEN) return { kind: 'critical' };
  if (token === undefined || !token.startsWith(LABEL_PREFIX)) return null;
  const id = token.slice(LABEL_PREFIX.length);
  return labels.some((label) => label.id === id) ? { kind: 'label', id } : null;
}

export function isCritical(classification: Classification, threshold: number): boolean {
  return classification.criticalProbability >= threshold;
}

export function shownLabels(
  classification: Classification,
  labels: LabelConfig[],
  threshold: number
): LabelConfig[] {
  return labels.filter((label) => {
    const probability = classification.labels[label.id];
    return probability !== undefined && probability >= threshold;
  });
}

export function matchesFilter(
  filter: RowFilter,
  classification: Classification | undefined,
  labels: LabelConfig[],
  threshold: number
): boolean {
  if (classification === undefined) return false;
  if (filter.kind === 'critical') return isCritical(classification, threshold);
  return shownLabels(classification, labels, threshold).some((label) => label.id === filter.id);
}

export function filterName(filter: RowFilter, labels: LabelConfig[]): string {
  if (filter.kind === 'critical') return 'Critical';
  return labels.find((label) => label.id === filter.id)?.name ?? filter.id;
}

export function filterOptions(
  labels: LabelConfig[],
  rows: (Classification | undefined)[],
  threshold: number,
  active: RowFilter | null
): FilterOption[] {
  const activeToken = active === null ? null : filterToken(active);
  const candidates: { filter: RowFilter; hue: number | null }[] = [
    { filter: { kind: 'critical' }, hue: null },
    ...labels.map((label, index) => ({
      filter: { kind: 'label', id: label.id } satisfies RowFilter,
      hue: index,
    })),
  ];
  const out: FilterOption[] = [];
  for (const { filter, hue } of candidates) {
    const token = filterToken(filter);
    const count = rows.filter((row) => matchesFilter(filter, row, labels, threshold)).length;
    if (count === 0 && token !== activeToken) continue;
    out.push({ token, name: filterName(filter, labels), count, hue });
  }
  return out;
}

export function filterRoute(hash: string): string {
  const route = routeKey(hash);
  const queryAt = route.indexOf('?');
  return queryAt === -1 ? route : route.slice(0, queryAt);
}

export function filterNote(name: string, shown: number, loaded: number): string {
  const rows = loaded === 1 ? 'row' : 'rows';
  return `Showing ${shown} of ${loaded} loaded ${rows} with ${name}. Filters this page only, not the whole mailbox.`;
}
