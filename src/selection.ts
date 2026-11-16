import { filterOptions, matchesFilter, type FilterOption, type RowFilter } from './filter';
import type { Classification, LabelConfig } from './shared';

// One loaded row as the bulk selection sees it: `checked` is Gmail's own checkbox,
// `hidden` is a row the active filter keeps off screen.
export type SelectableRow = {
  key: string;
  classification: Classification | undefined;
  checked: boolean;
  hidden: boolean;
};

// The keys of the rows to tick for `target`: on screen, not ticked yet, and carrying
// the chip. Unclassified rows never match, so halted and retrying rows stay unticked.
export function rowsToSelect(
  rows: SelectableRow[],
  target: RowFilter,
  labels: LabelConfig[],
  threshold: number
): string[] {
  return rows
    .filter((row) => !row.hidden && !row.checked)
    .filter((row) => matchesFilter(target, row.classification, labels, threshold))
    .map((row) => row.key);
}

// The bar's Select buttons: Critical and every label with a row on screen, counting
// every row on screen that carries it, ticked or not.
export function selectOptions(
  rows: SelectableRow[],
  labels: LabelConfig[],
  threshold: number
): FilterOption[] {
  const shown = rows.filter((row) => !row.hidden).map((row) => row.classification);
  return filterOptions(labels, shown, threshold, null);
}

export function selectedText(count: number): string {
  return `${count} selected`;
}

export function selectTitle(name: string, count: number): string {
  const rows = count === 1 ? 'row' : 'rows';
  return `Select the ${count} loaded ${rows} with ${name} in Gmail`;
}
