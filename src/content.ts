import {
  CACHE_PREFIX,
  DEFAULT_SETTINGS,
  MAX_CLASSIFY_BATCH,
  VIEWS,
  VIEW_SETTING_KEYS,
  cacheVersion,
  isChangedMessage,
  isContentState,
  isClassification,
  isLabelConfig,
  isProvider,
  routeKey,
  threadKey,
  viewFromHash,
  type ClassifyError,
  type ClassifyResult,
  type Classification,
  type EmailState,
  type LabelConfig,
  type Provider,
  type ContentState,
  type View,
} from './shared';
import {
  filterName,
  filterNote,
  filterOptions,
  filterRoute,
  filterToken,
  isCritical,
  matchesFilter,
  parseFilterToken,
  shownLabels,
  type RowFilter,
} from './filter';
import { isAuthRejection, pendingRow, type PendingRow } from './status';
import { parseColor, themeFromBackgrounds, type GmailTheme } from './theme';
import { rowFailureText } from './errors';

type Entry = {
  key: string;
  state: EmailState;
  row: HTMLTableRowElement;
};

type Failure = {
  failureCount: number;
  nextAttemptAt: number;
};

type Visual = {
  transform: string;
  transition: string;
  applied: string;
  transitionApplied: string;
};

type Ranked = {
  row: HTMLTableRowElement;
  index: number;
  height: number;
  top: number;
  unread: boolean;
  classification: Classification | undefined;
  match: boolean;
};

const DEBOUNCE_MS = 800;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 600_000;
const CHIP_HUES = 8;
const ANIMATION_TRANSITION = 'transform 180ms';
const HIDDEN_ATTRIBUTE = 'data-gc-hidden';
const CONTROL_SELECTOR = '[data-gc-filter], [data-gc-clear]';
const SENDER_SELECTOR = 'span[email][name]';
const ISOLATED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'keydown',
  'keyup',
  'keypress',
];

let bar: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let classObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedList: HTMLElement | null = null;
let inFlight = false;
let halted = false;
let errorMessage: string | null = null;
let enabled = DEFAULT_SETTINGS.enabled;
let threshold = DEFAULT_SETTINGS.threshold;
let classifyRead = DEFAULT_SETTINGS.classifyRead;
let provider: Provider = DEFAULT_SETTINGS.provider;
let labels: LabelConfig[] = [];
let keyVersion = cacheVersion([], DEFAULT_SETTINGS.provider);
let debounceId: number | undefined;
let generation = 0;
let retryId: number | undefined;
let currentList: HTMLElement | null = null;
let orderList: HTMLElement | null = null;
let orderRoute = '';
let animateNextOrder = false;
let orderPassQueued = false;
let animationCleanupId: number | undefined;
let activeFilter: RowFilter | null = null;
let activeRoute = '';
let theme: GmailTheme = 'light';
let themeCheckId: number | undefined;

const viewEnabled: Record<View, boolean> = {
  inbox: DEFAULT_SETTINGS.viewInbox,
  tabs: DEFAULT_SETTINGS.viewTabs,
  search: DEFAULT_SETTINGS.viewSearch,
  other: DEFAULT_SETTINGS.viewOther,
};

const candidates = new Map<string, Entry>();
const failures = new Map<string, Failure>();
const animating = new Set<HTMLTableRowElement>();
const visuals = new Map<HTMLTableRowElement, Visual>();
const sizeObserved = new Set<Element>();
const classifications = new Map<string, Classification>();

function schedule(): void {
  clearTimeout(debounceId);
  debounceId = window.setTimeout(() => {
    debounceId = undefined;
    void sync();
  }, DEBOUNCE_MS);
}

function clearRetry(): void {
  if (retryId !== undefined) {
    clearTimeout(retryId);
    retryId = undefined;
  }
}

function armRetry(): void {
  clearRetry();
  if (halted || !dispatchAllowed()) return;
  const now = Date.now();
  let earliest: number | undefined;
  for (const entry of candidates.values()) {
    if (classifications.has(entry.key)) continue;
    const nextAttemptAt = failures.get(entry.key)?.nextAttemptAt ?? 0;
    if (earliest === undefined || nextAttemptAt < earliest) earliest = nextAttemptAt;
  }
  if (earliest === undefined) return;
  retryId = window.setTimeout(() => {
    retryId = undefined;
    void dispatchPending();
  }, Math.max(0, earliest - now));
}

function dispatchAllowed(): boolean {
  const view = currentView();
  return enabled && view !== null && viewEnabled[view];
}

function canDispatch(startedGeneration: number, startedList: HTMLElement | undefined): boolean {
  if (startedGeneration !== generation) return false;
  if (!dispatchAllowed()) return false;
  return visibleList() === startedList;
}

function visibleMain(): HTMLElement | undefined {
  for (const main of document.querySelectorAll<HTMLElement>('div[role=main]')) {
    const visible = window.getComputedStyle(main).display !== 'none' && main.offsetParent !== null;
    if (visible && main.querySelector('tr.zA')) return main;
  }
  return undefined;
}

function visibleList(): HTMLElement | undefined {
  const main = visibleMain();
  if (!main) return undefined;
  for (const list of main.querySelectorAll<HTMLElement>('.Cp')) {
    if (!list.querySelector('tr.zA')) continue;
    if (list.offsetParent === null && list.getClientRects().length === 0) continue;
    return list;
  }
  return undefined;
}

function currentView(): View | null {
  if (!visibleMain()) return null;
  return viewFromHash(location.hash);
}

function senderOf(row: HTMLTableRowElement): Element | null {
  return row.querySelector('span.zF[email][name]') ?? row.querySelector(SENDER_SELECTOR);
}

function extractState(row: HTMLTableRowElement): EmailState | undefined {
  const sender = senderOf(row);
  const subjectEl =
    row.querySelector('span.bqe[data-thread-id]') ?? row.querySelector('[data-thread-id]');
  if (!sender || !subjectEl) return undefined;
  const threadId = subjectEl.getAttribute('data-thread-id');
  const legacyThreadId = subjectEl.getAttribute('data-legacy-thread-id');
  const lastMessageId = subjectEl.getAttribute('data-legacy-last-message-id');
  if (!threadId || !legacyThreadId || !lastMessageId) return undefined;
  const snippetEl = row.querySelector('span.y2');
  let snippet = '';
  if (snippetEl) {
    const clone = snippetEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('span.Zt').forEach((el) => el.remove());
    snippet = clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }
  const dateEl = row.querySelector('td.xW span[title]');
  const date = dateEl?.getAttribute('title') ?? row.querySelector('td.xW')?.textContent?.trim() ?? '';
  return {
    threadId,
    legacyThreadId,
    lastMessageId,
    fromName: sender.getAttribute('name') ?? '',
    fromEmail: sender.getAttribute('email') ?? '',
    subject: (subjectEl.textContent ?? '').replace(/\s+/g, ' ').trim(),
    snippet,
    date,
  };
}

function dispatchableEntries(): Entry[] {
  const now = Date.now();
  const out: Entry[] = [];
  for (const entry of candidates.values()) {
    if (classifications.has(entry.key)) continue;
    if (classifiableKey(entry.row) !== entry.key) continue;
    const failure = failures.get(entry.key);
    if (failure !== undefined && failure.nextAttemptAt > now) continue;
    out.push(entry);
  }
  return out;
}

function recordFailure(key: string): void {
  const failure = failures.get(key) ?? { failureCount: 0, nextAttemptAt: 0 };
  failure.failureCount += 1;
  failure.nextAttemptAt =
    Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (failure.failureCount - 1), MAX_BACKOFF_MS);
  failures.set(key, failure);
}

function isGcNode(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  for (const className of node.classList) {
    if (className.startsWith('gc-')) return true;
  }
  return node.closest('.gc-root, .gc-chips') !== null;
}

function isOwnRecord(record: MutationRecord): boolean {
  if (bar !== null && (record.target === bar || bar.contains(record.target))) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  if (nodes.length === 0) return false;
  return nodes.every(isGcNode);
}

function touchesList(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (
      currentList !== null &&
      record.target instanceof Node &&
      currentList.contains(record.target)
    ) {
      return true;
    }
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof Element)) continue;
      if (node.tagName === 'TR' || node.querySelector('tr.zA') !== null) return true;
    }
  }
  return false;
}

function observeRowClasses(list: HTMLElement | null): void {
  if (classObserver === null) {
    classObserver = new MutationObserver((records) => {
      if (!records.some((record) => record.target instanceof HTMLTableRowElement)) return;
      applyOrderNow();
      schedule();
    });
  }
  if (observedList === list) return;
  classObserver.disconnect();
  observedList = list;
  if (list !== null) {
    classObserver.observe(list, { attributes: true, attributeFilter: ['class'], subtree: true });
  }
}

function rowThreadId(row: HTMLTableRowElement): string | null {
  const carrier = row.querySelector('[data-thread-id]');
  return carrier?.getAttribute('data-thread-id') ?? null;
}

function cacheKeyOf(row: HTMLTableRowElement): string | null {
  const carrier = row.querySelector('[data-thread-id]');
  if (carrier === null) return null;
  const threadId = carrier.getAttribute('data-thread-id');
  const lastMessageId = carrier.getAttribute('data-legacy-last-message-id');
  if (threadId === null || lastMessageId === null) return null;
  return `${threadId}|${lastMessageId}|${keyVersion}`;
}

function isUnread(row: HTMLTableRowElement): boolean {
  return row.classList.contains('zE');
}

function classifiableKey(row: HTMLTableRowElement): string | null {
  if (!classifyRead && !isUnread(row)) return null;
  if (senderOf(row) === null) return null;
  return cacheKeyOf(row);
}

function visualOf(row: HTMLTableRowElement): Visual {
  const existing = visuals.get(row);
  if (existing !== undefined) return existing;
  const created: Visual = {
    transform: row.style.transform,
    transition: row.style.transition,
    applied: row.style.transform,
    transitionApplied: row.style.transition,
  };
  visuals.set(row, created);
  return created;
}

function pruneVisuals(rows: HTMLTableRowElement[]): void {
  const keep = new Set(rows);
  for (const [row, visual] of [...visuals]) {
    if (keep.has(row)) continue;
    if (row.style.transform === visual.applied) row.style.transform = visual.transform;
    if (row.style.transition === visual.transitionApplied) {
      row.style.transition = visual.transition;
    }
    visuals.delete(row);
    animating.delete(row);
  }
}

function observeSizes(list: HTMLElement | null): void {
  if (resizeObserver === null) return;
  const keep = new Set<Element>();
  if (list !== null) {
    keep.add(list);
    for (const row of list.querySelectorAll<HTMLTableRowElement>('tr.zA')) keep.add(row);
  }
  for (const element of [...sizeObserved]) {
    if (keep.has(element)) continue;
    resizeObserver.unobserve(element);
    sizeObserved.delete(element);
  }
  for (const element of keep) {
    if (sizeObserved.has(element)) continue;
    resizeObserver.observe(element);
    sizeObserved.add(element);
  }
}

function rowTranslateY(row: HTMLTableRowElement): number {
  const value = window.getComputedStyle(row).transform;
  if (value === 'none') return 0;
  const parts = value.slice(value.indexOf('(') + 1, -1).split(',');
  const parsed = Number.parseFloat(parts[parts.length === 16 ? 13 : 5] ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function applyRowOrder(): void {
  const list = currentList;
  if (list === null) return;
  const rows = [...list.querySelectorAll<HTMLTableRowElement>('tr.zA')];
  pruneVisuals(rows);
  const listTop = list.getBoundingClientRect().top;
  const items: Ranked[] = [];
  const filter = activeFilter;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const key = cacheKeyOf(row);
    const rect = row.getBoundingClientRect();
    const classification = key === null ? undefined : classifications.get(key);
    items.push({
      row,
      index,
      height: rect.height,
      top: rect.top - listTop - rowTranslateY(row),
      unread: isUnread(row),
      classification,
      match: filter === null || rowMatches(row, filter),
    });
  }
  const slots = items.map((item) => item.top);
  const gaps: { top: number; bottom: number }[] = [];
  for (let index = 1; index < items.length; index++) {
    const bottom = items[index - 1].top + items[index - 1].height;
    if (items[index].top - bottom > 0.01) gaps.push({ top: bottom, bottom: items[index].top });
  }
  const critical: Ranked[] = [];
  const unread: Ranked[] = [];
  const read: Ranked[] = [];
  const rest: Ranked[] = [];
  for (const item of items) {
    if (rowThreadId(item.row) === null) rest.push(item);
    else if (!item.unread) read.push(item);
    else if (item.classification !== undefined && isCritical(item.classification, threshold)) {
      critical.push(item);
    } else unread.push(item);
  }
  critical.sort((a, b) => {
    const classificationA = a.classification;
    const classificationB = b.classification;
    if (classificationA === undefined || classificationB === undefined) return 0;
    return compareClassifications(classificationA, classificationB);
  });
  unread.sort((a, b) => a.index - b.index);
  read.sort((a, b) => a.index - b.index);
  const animate =
    animateNextOrder && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  animateNextOrder = false;
  const changed: { row: HTMLTableRowElement; value: string }[] = [];
  const ranked = [...critical, ...unread, ...read, ...rest];
  const order =
    filter === null
      ? ranked
      : [...ranked.filter((item) => item.match), ...ranked.filter((item) => !item.match)];
  for (const item of items) {
    if (item.match === item.row.hasAttribute(HIDDEN_ATTRIBUTE)) {
      item.row.toggleAttribute(HIDDEN_ATTRIBUTE, !item.match);
    }
  }
  let previousBottom: number | undefined;
  for (let slot = 0; slot < order.length; slot++) {
    const item = order[slot];
    const slotTop = slots[slot] ?? item.top;
    let target = previousBottom === undefined ? slotTop : Math.max(slotTop, previousBottom);
    for (const gap of gaps) {
      if (gap.bottom <= target) continue;
      if (gap.top >= target + item.height) break;
      target = gap.bottom;
    }
    previousBottom = target + item.height;
    const visual = visualOf(item.row);
    if (item.row.style.transform !== visual.applied) visual.transform = item.row.style.transform;
    const offset = Math.round((target - item.top) * 100) / 100;
    const value =
      offset === 0
        ? visual.transform
        : visual.transform === ''
          ? `translateY(${offset}px)`
          : `${visual.transform} translateY(${offset}px)`;
    if (value !== visual.applied) {
      visual.applied = value;
      changed.push({ row: item.row, value });
    }
  }
  if (changed.length === 0) return;
  finishAnimations();
  if (animate) {
    for (const item of changed) {
      const visual = visualOf(item.row);
      if (item.row.style.transition !== visual.transitionApplied) {
        visual.transition = item.row.style.transition;
      }
      visual.transitionApplied = ANIMATION_TRANSITION;
      item.row.style.transition = ANIMATION_TRANSITION;
      animating.add(item.row);
    }
    animationCleanupId = window.setTimeout(finishAnimations, 250);
  }
  for (const item of changed) item.row.style.transform = item.value;
}

function finishAnimations(): void {
  clearTimeout(animationCleanupId);
  animationCleanupId = undefined;
  for (const row of animating) {
    const visual = visuals.get(row);
    if (visual === undefined) continue;
    if (row.style.transition !== ANIMATION_TRANSITION) continue;
    row.style.transition = visual.transition;
    visual.transitionApplied = visual.transition;
  }
  animating.clear();
}

function restoreList(list: HTMLElement | null): void {
  finishAnimations();
  for (const slot of list?.querySelectorAll('span.gc-chips') ?? []) slot.remove();
  for (const row of (list ?? document).querySelectorAll(`tr[${HIDDEN_ATTRIBUTE}]`)) {
    row.removeAttribute(HIDDEN_ATTRIBUTE);
  }
  for (const [row, visual] of [...visuals]) {
    if (list !== null && !list.contains(row)) continue;
    if (row.style.transform === visual.applied) row.style.transform = visual.transform;
    if (row.style.transition === visual.transitionApplied) {
      row.style.transition = visual.transition;
    }
    visuals.delete(row);
    animating.delete(row);
  }
  observeSizes(null);
  observer?.takeRecords();
  classObserver?.takeRecords();
}

function runOrderPass(): void {
  if (activeFilter !== null && filterRoute(location.hash) !== activeRoute) activeFilter = null;
  const view = currentView();
  const list = visibleList();
  const route = routeKey(location.hash);
  if (list !== orderList || route !== orderRoute) {
    restoreList(orderList);
    orderList = list ?? null;
    orderRoute = route;
  }
  if (!enabled || view === null || !viewEnabled[view] || !list) {
    restoreList(orderList);
    orderList = null;
    removeBar();
    candidates.clear();
    currentList = null;
    observeRowClasses(null);
    return;
  }
  currentList = list;
  observeRowClasses(list);
  observeSizes(list);
  ensureBar(list);
  render();
}

function applyOrderNow(): void {
  if (orderPassQueued) return;
  orderPassQueued = true;
  queueMicrotask(() => {
    orderPassQueued = false;
  });
  runOrderPass();
}

async function sync(): Promise<void> {
  runOrderPass();
  if (currentList === null || !dispatchAllowed()) return;
  const list = currentList;
  const seen = new Set<string>();
  const next = new Map<string, Entry>();
  for (const el of list.querySelectorAll<HTMLTableRowElement>('tr.zA')) {
    if (classifiableKey(el) === null) continue;
    const state = extractState(el);
    if (!state) continue;
    const key = threadKey(state, keyVersion);
    const entry = candidates.get(key) ?? { key, state, row: el };
    entry.state = state;
    entry.row = el;
    next.set(key, entry);
    seen.add(key);
  }
  for (const key of [...candidates.keys()]) {
    if (!seen.has(key)) candidates.delete(key);
  }
  candidates.clear();
  for (const [key, entry] of next.entries()) candidates.set(key, entry);
  await dispatchPending();
}

function removeBar(): void {
  bar?.remove();
  bar = null;
  clearRetry();
  observer?.takeRecords();
  classObserver?.takeRecords();
}

function rowInset(list: HTMLElement): number {
  const cell = list.querySelector('tr.zA td');
  if (cell === null) return 0;
  const listLeft = list.getBoundingClientRect().left;
  const content = cell.firstElementChild;
  if (content !== null && content.getBoundingClientRect().width > 0) {
    return Math.max(0, Math.round(content.getBoundingClientRect().left - listLeft));
  }
  const padding = Number.parseFloat(window.getComputedStyle(cell).paddingLeft);
  const box = cell.getBoundingClientRect().left - listLeft;
  return Math.max(0, Math.round(box + (Number.isNaN(padding) ? 0 : padding)));
}

function ensureBar(list: HTMLElement): void {
  const parent = list.parentElement;
  if (!parent) {
    removeBar();
    return;
  }
  if (bar !== null && !bar.isConnected) bar = null;
  if (bar !== null && bar.parentElement === parent && bar.nextElementSibling === list) {
    return;
  }
  if (bar === null) {
    const root = document.createElement('div');
    root.className = 'gc-root';
    root.id = 'gc-unread';
    bar = root;
  }
  parent.insertBefore(bar, list);
  bar.style.paddingLeft = `${rowInset(list)}px`;
  observer?.takeRecords();
  classObserver?.takeRecords();
}

async function dispatchPending(): Promise<void> {
  if (inFlight) return;
  if (halted || !dispatchAllowed()) {
    clearRetry();
    return;
  }
  if (dispatchableEntries().length === 0) {
    armRetry();
    return;
  }
  inFlight = true;
  errorMessage = null;
  render();
  const startedGeneration = generation;
  const startedList = visibleList();
  const attempted = new Set<string>();
  while (true) {
    if (!canDispatch(startedGeneration, startedList)) break;
    const batch = dispatchableEntries()
      .filter((entry) => !attempted.has(entry.key))
      .slice(0, MAX_CLASSIFY_BATCH);
    if (batch.length === 0) break;
    for (const entry of batch) attempted.add(entry.key);
    let response: ClassifyResult;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'classify',
        emails: batch.map((entry) => entry.state),
        labels,
      });
    } catch {
      if (!canDispatch(startedGeneration, startedList)) break;
      errorMessage = 'Classification request failed.';
      for (const entry of batch) recordFailure(entry.key);
      break;
    }
    if (!canDispatch(startedGeneration, startedList)) break;
    if (!response.ok) {
      if (response.error === 'needs_ack') {
        errorMessage = 'Open Jev Inbox to finish setup.';
        halted = true;
      } else if (response.error === 'missing_key') {
        errorMessage = 'No API key saved. Open the extension popup and add it.';
        halted = true;
      } else {
        errorMessage = 'Classification request failed.';
      }
      for (const entry of batch) recordFailure(entry.key);
      break;
    }
    let applied = false;
    let authFailure = false;
    const rowFailures: (ClassifyError | undefined)[] = [];
    for (const entry of batch) {
      const classification = response.results[entry.key];
      if (classification !== undefined) {
        classifications.set(entry.key, classification);
        failures.delete(entry.key);
        applied = true;
        continue;
      }
      const failure = response.errors[entry.key];
      rowFailures.push(failure);
      recordFailure(entry.key);
      if (isAuthRejection(failure?.status)) authFailure = true;
    }
    if (authFailure) halted = true;
    if (rowFailures.length > 0) errorMessage = rowFailureText(rowFailures);
    if (applied) animateNextOrder = true;
    render();
  }
  inFlight = false;
  render();
  armRetry();
}

function compareClassifications(a: Classification, b: Classification): number {
  if (b.urgencyScore !== a.urgencyScore) return b.urgencyScore - a.urgencyScore;
  return b.criticalProbability - a.criticalProbability;
}

function renderBar(): void {
  if (bar === null) return;
  let total = 0;
  let classifiable = 0;
  let remaining = 0;
  let loaded = 0;
  const rowClassifications: (Classification | undefined)[] = [];
  if (currentList !== null) {
    for (const row of currentList.querySelectorAll<HTMLTableRowElement>('tr.zA')) {
      loaded += 1;
      const key = classifiableKey(row);
      if (key === null) continue;
      if (isUnread(row)) total += 1;
      classifiable += 1;
      const classification = classifications.get(key);
      if (classification === undefined) remaining += 1;
      rowClassifications.push(classification);
    }
  }
  const status = inFlight ? remaining : 0;
  const filter = activeFilter;
  const options = filterOptions(labels, rowClassifications, threshold, filter);
  const shown =
    filter === null
      ? 0
      : rowClassifications.filter((row) => matchesFilter(filter, row, labels, threshold)).length;
  const optionSignature = options.map((option) => `${option.token}:${option.count}`).join(',');
  const signature = `${total}|${classifiable}|${status}|${errorMessage ?? ''}|${activeToken() ?? ''}|${loaded}|${shown}|${optionSignature}`;
  if (bar.dataset.gcSig === signature) return;
  bar.dataset.gcSig = signature;
  const focused = document.activeElement;
  const focusedControl =
    focused instanceof HTMLElement && bar.contains(focused)
      ? (focused.dataset.gcFilter ?? (focused.dataset.gcClear !== undefined ? '' : null))
      : null;
  bar.textContent = '';
  const count = document.createElement('span');
  count.className = 'gc-count';
  count.textContent = `${total} unread`;
  bar.appendChild(count);
  if (status > 0) {
    const statusEl = document.createElement('span');
    statusEl.className = 'gc-status';
    statusEl.textContent = classifyRead
      ? `Classifying ${remaining} of ${classifiable} loaded rows`
      : `Classifying ${remaining} of ${total} unread`;
    bar.appendChild(statusEl);
    const progress = document.createElement('span');
    progress.className = 'gc-progress';
    bar.appendChild(progress);
  }
  if (errorMessage) {
    const err = document.createElement('span');
    err.className = 'gc-error';
    err.textContent = errorMessage;
    bar.appendChild(err);
  }
  if (options.length > 0) {
    const group = document.createElement('span');
    group.className = 'gc-filters';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Filter the loaded rows by label');
    const caption = document.createElement('span');
    caption.className = 'gc-filters-label';
    caption.textContent = 'Filter loaded rows:';
    group.appendChild(caption);
    for (const option of options) {
      const parsed = parseFilterToken(option.token, labels);
      if (parsed === null) continue;
      const hue = option.hue === null ? 'gc-filter-critical' : `gc-hue-${option.hue % CHIP_HUES}`;
      const button = filterButton(parsed, `gc-filter ${hue}`, option.name);
      const count = document.createElement('span');
      count.className = 'gc-filter-count';
      count.textContent = String(option.count);
      button.appendChild(count);
      group.appendChild(button);
    }
    if (filter !== null) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'gc-clear';
      clear.dataset.gcClear = '';
      clear.textContent = 'Clear';
      group.appendChild(clear);
    }
    bar.appendChild(group);
  }
  if (filter !== null) {
    const note = document.createElement('span');
    note.className = 'gc-filter-note';
    note.textContent = filterNote(filterName(filter, labels), shown, loaded);
    bar.appendChild(note);
  }
  if (focusedControl !== null) {
    const selector =
      focusedControl === '' ? '[data-gc-clear]' : `[data-gc-filter="${CSS.escape(focusedControl)}"]`;
    const target =
      bar.querySelector<HTMLElement>(selector) ?? bar.querySelector<HTMLElement>('[data-gc-filter]');
    target?.focus();
  }
}

function chipSlot(row: HTMLTableRowElement): HTMLElement | null {
  const existing = row.querySelector<HTMLElement>('span.gc-chips');
  if (existing) return existing;
  const container = row.querySelector('.y6');
  const subject = row.querySelector('span.bog') ?? row.querySelector('[data-thread-id]');
  const slot = document.createElement('span');
  slot.className = 'gc-chips';
  slot.dataset.gcTheme = theme;
  if (container !== null) container.insertBefore(slot, container.firstChild);
  else if (subject?.parentElement != null) subject.parentElement.insertBefore(slot, subject);
  else return null;
  return slot;
}

function chipSignature(classification: Classification | undefined, pending: PendingRow): string {
  if (classification === undefined) return `p:${pending}`;
  let signature = `c:${isCritical(classification, threshold)}|${threshold}|${keyVersion}|`;
  for (const label of labels) {
    const probability = classification.labels[label.id];
    if (probability === undefined || probability < threshold) continue;
    signature += `${label.id}:${probability},`;
  }
  return signature;
}

function chipHasContent(classification: Classification | undefined, pending: PendingRow): boolean {
  if (classification === undefined) return pending !== 'none';
  if (isCritical(classification, threshold)) return true;
  return shownLabels(classification, labels, threshold).length > 0;
}

function renderChips(): void {
  const list = currentList;
  if (list === null) return;
  for (const row of list.querySelectorAll<HTMLTableRowElement>('tr.zA')) {
    const key = classifiableKey(row);
    if (key === null) {
      row.querySelector('span.gc-chips')?.remove();
      continue;
    }
    const classification = classifications.get(key);
    const pending = pendingRow(failures.get(key)?.failureCount ?? 0, halted);
    if (!chipHasContent(classification, pending)) {
      row.querySelector('span.gc-chips')?.remove();
      continue;
    }
    const slot = chipSlot(row);
    if (slot === null) continue;
    const signature = chipSignature(classification, pending);
    if (slot.dataset.gcSig === signature) continue;
    slot.dataset.gcSig = signature;
    slot.textContent = '';
    if (classification === undefined) {
      if (pending === 'retrying') {
        const marker = document.createElement('span');
        marker.className = 'gc-pending';
        marker.textContent = 'retrying';
        slot.appendChild(marker);
      } else {
        const dot = document.createElement('span');
        dot.className = 'gc-dot';
        slot.appendChild(dot);
      }
      continue;
    }
    if (isCritical(classification, threshold)) {
      slot.appendChild(filterButton({ kind: 'critical' }, 'gc-badge', 'Critical'));
    }
    for (const label of shownLabels(classification, labels, threshold)) {
      const hue = labels.indexOf(label) % CHIP_HUES;
      slot.appendChild(
        filterButton({ kind: 'label', id: label.id }, `gc-chip gc-hue-${hue}`, label.name)
      );
    }
  }
}

function filterButton(filter: RowFilter, className: string, text: string): HTMLButtonElement {
  const token = filterToken(filter);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.gcFilter = token;
  button.setAttribute('aria-pressed', String(activeToken() === token));
  button.title = `Show only the loaded rows with ${filterName(filter, labels)}`;
  button.textContent = text;
  return button;
}

function activeToken(): string | null {
  return activeFilter === null ? null : filterToken(activeFilter);
}

function rowMatches(row: HTMLTableRowElement, filter: RowFilter): boolean {
  const key = classifiableKey(row);
  if (key === null) return false;
  return matchesFilter(filter, classifications.get(key), labels, threshold);
}

function syncPressed(): void {
  const token = activeToken();
  for (const control of currentList?.querySelectorAll<HTMLElement>('[data-gc-filter]') ?? []) {
    const pressed = String(control.dataset.gcFilter === token);
    if (control.getAttribute('aria-pressed') !== pressed) control.setAttribute('aria-pressed', pressed);
  }
}

function setFilter(next: RowFilter | null): void {
  activeFilter = next;
  activeRoute = filterRoute(location.hash);
  render();
}

function onControl(control: HTMLElement): void {
  if (control.dataset.gcClear !== undefined) {
    setFilter(null);
    return;
  }
  const next = parseFilterToken(control.dataset.gcFilter, labels);
  if (next === null) return;
  setFilter(activeToken() === filterToken(next) ? null : next);
}

function isolateControls(): void {
  for (const type of ISOLATED_EVENTS) {
    window.addEventListener(
      type,
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const control = target.closest<HTMLElement>(CONTROL_SELECTOR);
        if (control === null || !isOwnControl(control)) return;
        if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
        event.stopImmediatePropagation();
        if (type === 'click') onControl(control);
      },
      true
    );
  }
}

function isOwnControl(control: HTMLElement): boolean {
  if (bar !== null && bar.contains(control)) return true;
  return control.closest('span.gc-chips') !== null;
}

function listBackgrounds(list: HTMLElement): string[] {
  const out: string[] = [];
  for (let node: Element | null = list; node !== null; node = node.parentElement) {
    const value = window.getComputedStyle(node).backgroundColor;
    out.push(value);
    const color = parseColor(value);
    if (color !== null && color.a >= 1) break;
  }
  return out;
}

function applyTheme(): void {
  const list = currentList;
  if (list === null || bar === null) return;
  theme = themeFromBackgrounds(listBackgrounds(list));
  if (bar.dataset.gcTheme !== theme) bar.dataset.gcTheme = theme;
  for (const slot of list.querySelectorAll<HTMLElement>('span.gc-chips')) {
    if (slot.dataset.gcTheme !== theme) slot.dataset.gcTheme = theme;
  }
}

function scheduleThemeCheck(): void {
  if (themeCheckId !== undefined) return;
  themeCheckId = window.requestAnimationFrame(() => {
    themeCheckId = undefined;
    applyTheme();
  });
}

function watchTheme(): void {
  const themeObserver = new MutationObserver(scheduleThemeCheck);
  themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  for (const root of [document.documentElement, document.body]) {
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleThemeCheck);
}

function render(): void {
  if (bar === null) return;
  applyTheme();
  renderBar();
  renderChips();
  syncPressed();
  applyRowOrder();
  observer?.takeRecords();
  classObserver?.takeRecords();
}

async function loadState(): Promise<ContentState> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'state' });
    if (isContentState(response)) return response;
  } catch {
    return { settings: {}, cache: {} };
  }
  return { settings: {}, cache: {} };
}

async function bootstrap(): Promise<void> {
  const state = await loadState();
  const stored = state.settings;
  if (typeof stored.enabled === 'boolean') enabled = stored.enabled;
  if (typeof stored.threshold === 'number') threshold = stored.threshold;
  if (typeof stored.classifyRead === 'boolean') classifyRead = stored.classifyRead;
  if (isProvider(stored.provider)) provider = stored.provider;
  if (Array.isArray(stored.labels)) labels = stored.labels.filter(isLabelConfig);
  keyVersion = cacheVersion(labels, provider);
  for (const view of VIEWS) {
    const key = VIEW_SETTING_KEYS[view];
    const storedValue = stored[key];
    if (typeof storedValue === 'boolean') viewEnabled[view] = storedValue;
  }
  for (const [cacheKey, value] of Object.entries(state.cache)) {
    if (!cacheKey.endsWith(`|${keyVersion}`)) continue;
    if (isClassification(value)) classifications.set(cacheKey, value);
  }
  observer = new MutationObserver((records) => {
    const foreign = records.filter((record) => !isOwnRecord(record));
    if (foreign.length === 0) return;
    if (!touchesList(foreign)) return;
    applyOrderNow();
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  isolateControls();
  watchTheme();
  resizeObserver = new ResizeObserver(() => {
    applyOrderNow();
  });
  window.addEventListener('hashchange', () => {
    generation += 1;
    finishAnimations();
    applyOrderNow();
    schedule();
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || !isChangedMessage(message)) return;
    const { changes } = message;
    let structural = false;
    let immediateOrder = false;
    for (const [storageKey, change] of Object.entries(changes)) {
      if (!storageKey.startsWith(CACHE_PREFIX)) continue;
      const cacheKey = storageKey.slice(CACHE_PREFIX.length);
      if (!cacheKey.endsWith(`|${keyVersion}`)) continue;
      if (isClassification(change.newValue)) {
        classifications.set(cacheKey, change.newValue);
        failures.delete(cacheKey);
      } else {
        classifications.delete(cacheKey);
        failures.delete(cacheKey);
      }
    }
    if (message.keysChanged) {
      halted = false;
      failures.clear();
    }
    if (changes.privacyAck) {
      halted = false;
      failures.clear();
    }
    if (changes.provider) {
      provider = isProvider(changes.provider.newValue)
        ? changes.provider.newValue
        : DEFAULT_SETTINGS.provider;
      keyVersion = cacheVersion(labels, provider);
      classifications.clear();
      failures.clear();
      halted = false;
      activeFilter = null;
      structural = true;
    }
    if (changes.labels) {
      const value = changes.labels.newValue;
      labels = Array.isArray(value) ? value.filter(isLabelConfig) : [];
      keyVersion = cacheVersion(labels, provider);
      candidates.clear();
      classifications.clear();
      failures.clear();
      activeFilter = null;
      structural = true;
    }
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      activeFilter = null;
      structural = true;
      immediateOrder = true;
    }
    if (changes.classifyRead) {
      classifyRead = changes.classifyRead.newValue === true;
      candidates.clear();
      activeFilter = null;
      structural = true;
      immediateOrder = true;
    }
    if (changes.threshold && typeof changes.threshold.newValue === 'number') {
      threshold = changes.threshold.newValue;
    }
    for (const view of VIEWS) {
      const key = VIEW_SETTING_KEYS[view];
      const change = changes[key];
      if (!change) continue;
      viewEnabled[view] =
        typeof change.newValue === 'boolean' ? change.newValue : DEFAULT_SETTINGS[key];
      activeFilter = null;
      structural = true;
      immediateOrder = true;
    }
    if (structural) generation += 1;
    if (immediateOrder) applyOrderNow();
    schedule();
  });
  void sync();
}

bootstrap();
