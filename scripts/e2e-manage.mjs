import assert from 'node:assert/strict';
import { join } from 'node:path';

const MANAGE_LABELS = [
  { id: 'visa', name: 'Visa', description: 'Residence permits, IND letters, immigration appointments' },
  { id: 'money', name: 'Money', description: 'Invoices, payments, bank statements' },
  { id: 'home', name: 'Home', description: 'Rent, utilities, landlord and building notices' },
];

const THREADS = [
  ['visa', 'IND', 'post@ind.example', 'Your appointment is confirmed', 2],
  ['visa', 'IND', 'post@ind.example', 'Documents received', 1],
  ['visa', 'Embassy', 'consular@embassy.example', 'Visa interview', 2],
  ['money', 'Shop Billing', 'billing@shop.example', 'Receipt 1041', 0],
  ['money', 'Shop Billing', 'Billing@Shop.example', 'Receipt 1042', 0],
  ['money', 'Shop Billing', 'billing@shop.example', 'Receipt 1043', 0],
  ['money', 'Bank', 'alerts@bank.example', 'Payment overdue', 3],
  ['home', 'Landlord', 'landlord@rent.example', 'Boiler maintenance on Friday', 1],
  [null, 'Weekly Letters', 'news@letters.example', 'This week in design', 0],
  [null, 'Weekly Letters', 'news@letters.example', 'Last week in design', 0],
  [null, 'Odd Sender', 'odd sender@weird.example', 'Address with a space', 0],
];

function entry(labelId, fromName, fromEmail, subject, urgency, ts) {
  return {
    criticalProbability: urgency === 3 ? 0.9 : 0.1,
    urgencyScore: urgency,
    labels: Object.fromEntries(MANAGE_LABELS.map((label) => [label.id, label.id === labelId ? 0.9 : 0.05])),
    ts,
    thread: { fromName, fromEmail, subject, date: `Nov ${(ts % 28) + 1}` },
  };
}

async function cacheKeys(worker) {
  return worker.evaluate(() =>
    chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith('crit:')))
  );
}

async function groups(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.group')].map((group) => [
      group.querySelector('.group-head label span').textContent,
      Number(group.querySelector('.group-head .count').textContent),
    ])
  );
}

function decodedQuery(href) {
  const match = /^https:\/\/mail\.google\.com\/mail\/u\/(\d+)\/#search\/(.+)$/.exec(href);
  assert.ok(match !== null, `Gmail search URL: ${href}`);
  return { account: Number(match[1]), query: decodeURIComponent(match[2]) };
}

function senders(query) {
  return query.replace(/^(in:inbox )?from:\(|\)$/g, '').split(' OR ').sort();
}

async function searchLinks(page) {
  return page.locator('#searches a').evaluateAll((links) => links.map((a) => ({ text: a.textContent, href: a.href })));
}

// A cache written before entries kept a sender: nothing is listed and the page says why.
async function checkUpgradeState({ context, worker, extensionId, outDir, version, widths, themes }) {
  const old = { labels: MANAGE_LABELS, provider: 'gateway', threshold: 0.7 };
  for (let i = 0; i < 3; i++) {
    old[`crit:old${i}|m|${version}`] = { criticalProbability: 0.1, urgencyScore: 0, labels: { visa: 0.9 }, ts: i };
  }
  await worker.evaluate((items) => chrome.storage.local.set(items), old);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manage.html`);
  await page.waitForFunction(() => document.getElementById('summary')?.textContent !== 'Loading...');
  assert.equal(await page.locator('.group').count(), 0, 'no groups from entries without a sender');
  assert.equal(await page.locator('#summary').innerText(), 'No classified thread has its sender saved yet.');
  assert.match(await page.locator('#empty').innerText(), /^3 threads were classified before Jev Inbox kept the sender/);
  assert.equal(await page.locator('#missing').isVisible(), false, 'the empty note alone explains the missing senders');
  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(outDir, `manage-upgrade-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.close();
  await worker.evaluate((keys) => chrome.storage.local.remove(keys), Object.keys(old).filter((key) => key.startsWith('crit:')));
  return true;
}

export async function checkManage({ context, worker, popup, extensionId, outDir, cacheVersion, widths, themes, gmailMax }) {
  const version = cacheVersion(MANAGE_LABELS, 'gateway');
  await worker.evaluate(async (keys) => chrome.storage.local.remove(keys), await cacheKeys(worker));
  const upgrade = await checkUpgradeState({ context, worker, extensionId, outDir, version, widths, themes });
  const seed = { labels: MANAGE_LABELS, provider: 'gateway', threshold: 0.7 };
  THREADS.forEach(([labelId, name, email, subject, urgency], index) => {
    seed[`crit:t${index}|m${index}|${version}`] = entry(labelId, name, email, subject, urgency, 1000 + index);
  });
  seed[`crit:old|m|${version}`] = { criticalProbability: 0.1, urgencyScore: 0, labels: { visa: 0.9 }, ts: 1 };
  await worker.evaluate((items) => chrome.storage.local.set(items), seed);

  const gmailU1 = await context.newPage();
  await gmailU1.goto('https://mail.google.com/mail/u/1/#inbox');

  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const [page] = await Promise.all([context.waitForEvent('page'), popup.locator('#manage').click()]);
  await page.waitForLoadState();
  assert.equal(page.url(), `chrome-extension://${extensionId}/manage.html`, 'Manage opens the manage page in a tab');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.group');
  const before = await worker.evaluate(() => chrome.storage.local.get(null));

  assert.deepEqual(
    await groups(page),
    [
      ['Visa', 3],
      ['Money', 4],
      ['Home', 1],
      ['No label', 3],
    ],
    'groups by top label with thread counts'
  );
  const money = await page.locator('.group[data-label="money"] .sender').evaluateAll((items) =>
    items.map((item) => [item.dataset.email, Number(item.querySelector('.count').textContent), item.querySelector('.sender-latest').textContent])
  );
  assert.deepEqual(
    money,
    [
      ['billing@shop.example', 3, 'Receipt 1043 - Nov 26'],
      ['alerts@bank.example', 1, 'Payment overdue - Nov 27'],
    ],
    'groups senders across letter case with counts and the latest subject'
  );
  assert.match(await page.locator('#summary').innerText(), /^11 classified threads from 7 senders/);
  assert.match(await page.locator('#missing').innerText(), /^1 classification was saved without a sender/);
  assert.equal(
    await page.locator('.sender[data-email="odd sender@weird.example"] .pick').isDisabled(),
    true,
    'an address that cannot go in a search cannot be picked'
  );

  await page.locator('#labelFilter').selectOption('money');
  assert.deepEqual(await groups(page), [['Money', 4]], 'label filter');
  await page.locator('#labelFilter').selectOption('all');
  await page.locator('#minUrgency').selectOption('3');
  assert.deepEqual(await groups(page), [['Money', 1]], 'minimum urgency filter');
  await page.locator('#minUrgency').selectOption('0');
  await page.locator('#maxUrgency').selectOption('0');
  assert.deepEqual(await groups(page), [['Money', 3], ['No label', 3]], 'maximum urgency filter');
  await page.locator('#maxUrgency').selectOption('3');
  await page.locator('#textFilter').fill('boiler');
  assert.deepEqual(await groups(page), [['Home', 1]], 'text filter matches the subject');
  await page.locator('#textFilter').fill('');

  assert.equal(await page.locator('#searches a').count(), 0, 'no search before a pick');
  const billing = page.locator('.sender[data-email="billing@shop.example"] .pick');
  await billing.focus();
  await page.keyboard.press('Space');
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest('.sender')?.dataset.email),
    'billing@shop.example',
    'focus stays on the checkbox after a pick'
  );
  await page.locator('.group[data-label="visa"] .pick-all').check();
  let links = await searchLinks(page);
  assert.equal(links.length, 1, 'one search');
  assert.equal(links[0].text, 'Open in Gmail');
  let search = decodedQuery(links[0].href);
  assert.equal(search.account, 1, 'the account of the open Gmail tab by default');
  assert.match(search.query, /^in:inbox from:\(/, 'Inbox only by default');
  assert.deepEqual(senders(search.query), ['billing@shop.example', 'consular@embassy.example', 'post@ind.example']);
  assert.match(await page.locator('#pickCount').innerText(), /^3 senders picked/);

  const accounts = await page.locator('#account option').evaluateAll((options) => options.map((o) => o.value));
  assert.deepEqual(accounts, ['1'], 'accounts come from the open Gmail tabs');
  await page.locator('#inboxOnly').uncheck();
  links = await searchLinks(page);
  search = decodedQuery(links[0].href);
  assert.equal(search.account, 1, 'search opens in the open account');
  assert.match(search.query, /^from:\(/, 'all mail when Inbox only is off');
  const [opened] = await Promise.all([context.waitForEvent('page'), page.locator('#searches a').click()]);
  assert.equal(opened.url(), links[0].href, 'Open in Gmail opens the search in a tab');
  await opened.close();
  await page.locator('#inboxOnly').check();

  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `manage page has no horizontal scroll at ${width} (${overflow}px)`);
      await page.screenshot({ path: join(outDir, `manage-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });

  const after = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(after, before, 'the manage page never writes storage');

  const bulk = {};
  for (let i = 0; i < 150; i++) {
    bulk[`crit:bulk${i}|m|${version}`] = entry(null, `Letter ${i}`, `sender${i}@newsletter-${i}.example`, `Issue ${i}`, 0, 2000 + i);
  }
  await worker.evaluate((items) => chrome.storage.local.set(items), bulk);
  await page.reload();
  await page.waitForSelector('.group');
  await page.locator('.group[data-label="none"] .pick-all').check();
  links = await searchLinks(page);
  assert.ok(links.length > 1, 'a long pick is split into several searches');
  const found = [];
  links.forEach((link, index) => {
    assert.match(link.text, new RegExp(`^Search ${index + 1} of ${links.length} \\(\\d+ senders\\)$`));
    const { query } = decodedQuery(link.href);
    assert.ok(query.length <= gmailMax, `search ${index + 1} is ${query.length} <= ${gmailMax}`);
    found.push(...senders(query));
  });
  assert.equal(found.length, 151, 'every searchable picked sender is in exactly one search');
  assert.equal(new Set(found).size, 151);
  assert.equal(await page.locator('#skipped').isVisible(), false, 'unsearchable senders are never picked');
  await page.screenshot({ path: join(outDir, 'manage-split-light-1440.png') });

  await page.close();
  await gmailU1.close();
  return { groups: 4, splitSearches: links.length, upgrade };
}
