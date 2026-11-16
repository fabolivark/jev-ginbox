import {
  ALL_LABELS,
  NO_LABEL,
  URGENCY_MAX,
  URGENCY_MIN,
  filterThreads,
  gmailAccounts,
  gmailSearchUrl,
  groupThreads,
  isSearchableEmail,
  senderQueries,
  storedLabels,
  triageThreads,
  type LabelGroup,
  type TriageFilter,
  type TriageThread,
} from './triage';
import type { LabelConfig } from './shared';

const URGENCY_NAMES = ['Not urgent', 'Somewhat urgent', 'Urgent', 'Immediately urgent'];

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing`);
  return found;
}

const summary = element('summary', HTMLParagraphElement);
const labelFilter = element('labelFilter', HTMLSelectElement);
const minUrgency = element('minUrgency', HTMLSelectElement);
const maxUrgency = element('maxUrgency', HTMLSelectElement);
const textFilter = element('textFilter', HTMLInputElement);
const groupsEl = element('groups', HTMLDivElement);
const emptyEl = element('empty', HTMLParagraphElement);
const missingEl = element('missing', HTMLParagraphElement);
const pickCount = element('pickCount', HTMLParagraphElement);
const inboxOnly = element('inboxOnly', HTMLInputElement);
const accountSelect = element('account', HTMLSelectElement);
const searchesEl = element('searches', HTMLDivElement);
const skippedEl = element('skipped', HTMLParagraphElement);
const clearPicks = element('clearPicks', HTMLButtonElement);

let labels: LabelConfig[] = [];
let threads: TriageThread[] = [];
let missing = 0;
const picked = new Set<string>();

function option(value: string, text: string): HTMLOptionElement {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = text;
  return el;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function currentFilter(): TriageFilter {
  return {
    label: labelFilter.value,
    minUrgency: Number(minUrgency.value),
    maxUrgency: Number(maxUrgency.value),
    text: textFilter.value,
  };
}

function setPicked(emails: string[], on: boolean): void {
  for (const email of emails) {
    if (on) picked.add(email);
    else picked.delete(email);
  }
  render();
}

function renderGroup(group: LabelGroup): HTMLElement {
  const section = document.createElement('section');
  section.className = 'group';
  section.dataset.label = group.id ?? NO_LABEL;

  const head = document.createElement('div');
  head.className = 'group-head';
  const headLabel = document.createElement('label');
  const all = document.createElement('input');
  all.type = 'checkbox';
  all.className = 'pick-all';
  const searchable = group.senders.map((s) => s.email).filter(isSearchableEmail);
  const pickedHere = searchable.filter((email) => picked.has(email)).length;
  all.checked = searchable.length > 0 && pickedHere === searchable.length;
  all.indeterminate = pickedHere > 0 && pickedHere < searchable.length;
  all.disabled = searchable.length === 0;
  all.setAttribute('aria-label', `Pick all senders in ${group.name}`);
  all.addEventListener('change', () => setPicked(searchable, all.checked));
  const name = document.createElement('span');
  name.textContent = group.name;
  headLabel.append(all, name);
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(group.count);
  count.title = plural(group.count, 'thread', 'threads');
  head.append(headLabel, count);
  section.append(head);

  const list = document.createElement('ul');
  list.className = 'senders';
  for (const sender of group.senders) {
    const item = document.createElement('li');
    item.className = 'sender';
    item.dataset.email = sender.email;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pick';
    box.value = sender.email;
    const canSearch = isSearchableEmail(sender.email);
    box.disabled = !canSearch;
    box.checked = picked.has(sender.email);
    box.addEventListener('change', () => setPicked([sender.email], box.checked));

    const main = document.createElement('div');
    main.className = 'sender-main';
    const senderName = document.createElement('div');
    senderName.className = 'sender-name';
    senderName.textContent = sender.name.length > 0 ? sender.name : sender.email;
    const senderEmail = document.createElement('div');
    senderEmail.className = 'sender-email';
    senderEmail.textContent = sender.email;
    const latest = document.createElement('div');
    latest.className = 'sender-latest';
    const latestText = sender.latestDate.length > 0 ? `${sender.latestSubject} - ${sender.latestDate}` : sender.latestSubject;
    latest.textContent = latestText;
    latest.title = latestText;
    main.append(senderName, senderEmail, latest);
    if (!canSearch) {
      const note = document.createElement('div');
      note.className = 'sender-note';
      note.textContent = 'This address cannot go in a Gmail search.';
      main.append(note);
    }

    const senderCount = document.createElement('span');
    senderCount.className = 'count';
    senderCount.textContent = String(sender.count);
    senderCount.title = plural(sender.count, 'thread', 'threads');
    label.append(box, main, senderCount);
    item.append(label);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderSearches(): void {
  const emails = [...picked];
  const searchable = emails.filter(isSearchableEmail);
  const queries = senderQueries(searchable, { inboxOnly: inboxOnly.checked });
  const account = Number(accountSelect.value);
  pickCount.textContent =
    emails.length === 0
      ? 'Pick senders to build a Gmail search.'
      : `${plural(emails.length, 'sender', 'senders')} picked.`;
  searchesEl.replaceChildren(
    ...queries.map((query, index) => {
      const link = document.createElement('a');
      link.className = 'open';
      link.href = gmailSearchUrl(query, account);
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.title = query;
      const senders = query.split(' OR ').length;
      link.textContent =
        queries.length === 1
          ? 'Open in Gmail'
          : `Search ${index + 1} of ${queries.length} (${plural(senders, 'sender', 'senders')})`;
      return link;
    })
  );
  const skipped = emails.length - searchable.length;
  skippedEl.hidden = skipped === 0;
  skippedEl.textContent = `${plural(skipped, 'picked address', 'picked addresses')} cannot go in a Gmail search.`;
  clearPicks.disabled = emails.length === 0;
}

// Rendering replaces the list, so put focus back on the same checkbox afterwards.
function focusedPick(): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !groupsEl.contains(active)) return undefined;
  const group = active.closest<HTMLElement>('.group')?.dataset.label ?? '';
  const sender = active.closest<HTMLElement>('.sender')?.dataset.email;
  return sender === undefined
    ? `.group[data-label="${CSS.escape(group)}"] .pick-all`
    : `.group[data-label="${CSS.escape(group)}"] .sender[data-email="${CSS.escape(sender)}"] .pick`;
}

function render(): void {
  const focus = focusedPick();
  const shown = filterThreads(threads, currentFilter());
  const groups = groupThreads(shown, labels);
  const senders = new Set(threads.map((t) => t.fromEmail.toLowerCase())).size;
  summary.textContent =
    threads.length === 0
      ? missing > 0
        ? 'No classified thread has its sender saved yet.'
        : 'Nothing classified yet.'
      : `${plural(threads.length, 'classified thread', 'classified threads')} from ${plural(senders, 'sender', 'senders')}, stored in this browser.`;
  groupsEl.replaceChildren(...groups.map(renderGroup));
  emptyEl.hidden = groups.length > 0;
  emptyEl.textContent =
    threads.length > 0
      ? 'No thread matches these filters.'
      : missing > 0
        ? `${plural(missing, 'thread was', 'threads were')} classified before Jev Inbox kept the sender, so ${missing === 1 ? 'it is' : 'they are'} not listed. Threads classified from now on show up here. To list the loaded rows sooner, Clear cache in the popup: they are classified again, which sends them to the provider again.`
        : 'Open Gmail with Jev Inbox on; the threads it classifies are listed here.';
  missingEl.hidden = missing === 0 || threads.length === 0;
  renderSearches();
  if (focus !== undefined) groupsEl.querySelector<HTMLInputElement>(focus)?.focus();
}

function fillFilters(): void {
  labelFilter.replaceChildren(
    option(ALL_LABELS, 'All labels'),
    ...labels.map((label) => option(label.id, label.name)),
    option(NO_LABEL, 'No label')
  );
  for (let score = URGENCY_MIN; score <= URGENCY_MAX; score++) {
    const name = URGENCY_NAMES[score] ?? String(score);
    minUrgency.append(option(String(score), name));
    maxUrgency.append(option(String(score), name));
  }
  minUrgency.value = String(URGENCY_MIN);
  maxUrgency.value = String(URGENCY_MAX);
}

async function fillAccounts(): Promise<void> {
  let urls: (string | undefined)[] = [];
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    urls = tabs.map((tab) => tab.url);
  } catch {
    urls = [];
  }
  const found = gmailAccounts(urls);
  const accounts = found.length > 0 ? found : [0];
  accountSelect.replaceChildren(
    ...accounts.map((account) =>
      option(String(account), found.includes(account) ? `mail/u/${account} (open in a tab)` : `mail/u/${account}`)
    )
  );
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  labels = storedLabels(stored);
  const data = triageThreads(stored);
  threads = data.threads;
  missing = data.missing;
  fillFilters();
  await fillAccounts();
  missingEl.textContent = `${plural(missing, 'classification was', 'classifications were')} saved without a sender and ${missing === 1 ? 'is' : 'are'} not listed. Clear cache in the popup to classify ${missing === 1 ? 'it' : 'them'} again with the sender.`;
  render();
}

for (const control of [labelFilter, minUrgency, maxUrgency]) control.addEventListener('change', render);
textFilter.addEventListener('input', render);
inboxOnly.addEventListener('change', renderSearches);
accountSelect.addEventListener('change', renderSearches);
clearPicks.addEventListener('click', () => {
  picked.clear();
  render();
});

void load();
