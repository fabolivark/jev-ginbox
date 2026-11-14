import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = join(root, 'dist');
const outDir = join(root, 'e2e-results');
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const WIDTHS = [1440, 768, 390, 320];
const THEMES = ['light', 'dark'];

const LABELS = [
  { id: 'visa', name: 'Visa', description: 'Residence permits, IND letters, immigration appointments' },
  { id: 'money', name: 'Money', description: 'Invoices, payments, bank statements' },
  { id: 'home', name: 'Home', description: 'Rent, utilities, landlord and building notices' },
];

function fixtureHtml() {
  return readFileSync(join(root, 'dev', 'demo.html'), 'utf8')
    .replace(/<link rel="stylesheet" href="..\/dist\/section.css" \/>/, '')
    .replace(/<script src="..\/dist\/[a-z]+\.js"><\/script>/g, '');
}

function unreadRows(html) {
  const rows = [];
  const pattern =
    /<tr class="zA zE">[\s\S]*?data-thread-id="([^"]+)"[\s\S]*?data-legacy-last-message-id="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) rows.push({ threadId: match[1], lastMessageId: match[2] });
  return rows;
}

async function isolatedWorld(cdp, extensionId) {
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await cdp.send('Runtime.enable');
  return async () => {
    for (let i = 0; i < 50; i++) {
      const found = contexts.find(
        (context) => context.auxData?.type === 'isolated' && context.origin.includes(extensionId)
      );
      if (found !== undefined) return found.id;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('content script world not found');
  };
}

async function evaluateIn(cdp, contextId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    contextId,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.text);
  return result.value;
}

function tbodyHtml(source) {
  const match = /<tbody>([\s\S]*?)<\/tbody>/.exec(source);
  assert.ok(match !== null, 'fixture has a tbody');
  return match[1];
}

const EVENT_TYPES = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress'];

async function watchLeaks(page) {
  await page.evaluate((types) => {
    window.gcLeaks = [];
    const record = (where) => (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-gc-filter], [data-gc-clear]') !== null) {
        window.gcLeaks.push(`${where}:${event.type}`);
      }
    };
    for (const type of types) {
      document.addEventListener(type, record('document'));
      document.body.addEventListener(type, record('body'), true);
      for (const row of document.querySelectorAll('tr.zA')) row.addEventListener(type, record('row'));
    }
  }, EVENT_TYPES);
}

async function leaks(page) {
  return page.evaluate(() => window.gcLeaks);
}

async function visibleThreads(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.Cp tr.zA')];
    const shown = rows.filter((row) => getComputedStyle(row).visibility !== 'hidden');
    const hidden = rows.filter((row) => getComputedStyle(row).visibility === 'hidden');
    const bottom = Math.max(...shown.map((row) => row.getBoundingClientRect().bottom));
    const top = Math.min(...hidden.map((row) => row.getBoundingClientRect().top));
    return {
      threads: shown.map((row) => row.querySelector('[data-thread-id]')?.getAttribute('data-thread-id')).sort(),
      shownOnTop: hidden.length === 0 || bottom <= top + 0.5,
    };
  });
}

async function settle(page) {
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await page.waitForTimeout(300);
}

async function activeFilter(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#gc-unread [data-gc-filter][aria-pressed="true"]')].map((el) =>
      el.getAttribute('data-gc-filter')
    )
  );
}

async function checkFilter(page, worker, rows, originalTbody, version) {
  const all = rows.length;
  const loaded = await page.locator('.Cp tr.zA').count();
  const money = [rows[1].threadId, rows[2].threadId].sort();
  const critical = [rows[0].threadId];
  await watchLeaks(page);

  const rowChip = page.locator(`tr.zA:has([data-thread-id="${rows[2].threadId}"]) [data-gc-filter="label:money"]`);
  assert.equal(await rowChip.evaluate((el) => el.tagName), 'BUTTON', 'row chip is a button');
  assert.equal(await rowChip.getAttribute('aria-pressed'), 'false', 'row chip starts unpressed');
  await rowChip.click();
  await settle(page);
  let view = await visibleThreads(page);
  assert.deepEqual(view.threads, money, 'row chip click shows only the Money rows');
  assert.equal(view.shownOnTop, true, 'Money rows sit above the hidden rows');
  assert.deepEqual(await activeFilter(page), ['label:money'], 'bar shows Money as active');
  assert.equal(await rowChip.getAttribute('aria-pressed'), 'true', 'row chip is pressed');
  const note = await page.locator('#gc-unread').innerText();
  assert.match(note, new RegExp(`Showing 2 of ${loaded} loaded rows with Money`), 'bar states the count');
  assert.match(note, /not the whole mailbox/, 'bar says it filters loaded rows only');
  assert.deepEqual(await leaks(page), [], 'a chip click never reaches Gmail');

  await page.evaluate((markup) => {
    document.querySelector('.Cp tbody').innerHTML = markup;
  }, originalTbody);
  await page.waitForSelector('tr.zA [data-gc-filter="critical"]', { state: 'attached', timeout: 10000 });
  await settle(page);
  view = await visibleThreads(page);
  assert.deepEqual(view.threads, money, 'filter survives a Gmail re-render');
  await watchLeaks(page);

  const key = `crit:${rows[3].threadId}|${rows[3].lastMessageId}|${version}`;
  await worker.evaluate(async (entry) => {
    const current = await chrome.storage.local.get(entry);
    await chrome.storage.local.set({ [entry]: { ...current[entry], ts: Date.now() } });
  }, key);
  await settle(page);
  assert.deepEqual((await visibleThreads(page)).threads, money, 'filter survives a cache change');

  const barCritical = page.locator('#gc-unread [data-gc-filter="critical"]');
  await barCritical.focus();
  await page.keyboard.press('Enter');
  await settle(page);
  assert.deepEqual((await visibleThreads(page)).threads, critical, 'Enter on Critical switches the filter');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('data-gc-filter')),
    'critical',
    'focus stays on the Critical button'
  );
  await page.keyboard.press('Space');
  await settle(page);
  assert.equal((await visibleThreads(page)).threads.length, loaded, 'Space on the active chip clears');
  assert.deepEqual(await activeFilter(page), [], 'no active filter after toggling off');
  assert.deepEqual(await leaks(page), [], 'keyboard activation never reaches Gmail');

  await page.locator('#gc-unread [data-gc-filter="label:money"]').click();
  await settle(page);
  await page.locator('#gc-unread [data-gc-clear]').click();
  await settle(page);
  assert.equal((await visibleThreads(page)).threads.length, loaded, 'Clear restores the full list');
  assert.equal(await page.locator('#gc-unread [data-gc-clear]').count(), 0, 'Clear leaves with the filter');

  await page.locator('#gc-unread [data-gc-filter="label:money"]').click();
  await page.evaluate(() => {
    location.hash = '#inbox?compose=new';
  });
  await settle(page);
  assert.deepEqual((await visibleThreads(page)).threads, money, 'opening Compose keeps the filter');
  await page.evaluate(() => {
    location.hash = '#category/social';
  });
  await settle(page);
  assert.deepEqual(await activeFilter(page), [], 'another list clears the filter');
  await page.evaluate(() => {
    location.hash = '#inbox';
  });
  await settle(page);
  assert.equal((await visibleThreads(page)).threads.length, loaded, 'back on the inbox nothing is hidden');
  assert.deepEqual(await activeFilter(page), [], 'the filter does not come back');
  assert.deepEqual(await leaks(page), [], 'no filter control event reaches Gmail');
  return { all, loaded, money, critical };
}

async function shootFilteredGmail(page) {
  for (const theme of THEMES) {
    const url = theme === 'dark' ? GMAIL_URL.replace('#', '?theme=dark#') : GMAIL_URL;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await page.waitForSelector('#gc-unread [data-gc-filter="label:money"]', { timeout: 15000 });
    await page.locator('#gc-unread [data-gc-filter="label:money"]').click();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await page.screenshot({ path: join(outDir, `gmail-filtered-${theme}-${width}.png`), fullPage: true });
    }
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

const providerCalls = [];
await context.route(/^https:\/\/(ai-gateway\.vercel\.sh|api\.typesafe\.ai)\//, (route) => {
  providerCalls.push(route.request().url());
  return route.abort();
});
const html = fixtureHtml();
await context.route('https://mail.google.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: html })
);

try {
  let [worker] = context.serviceWorkers();
  if (worker === undefined) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  const rows = unreadRows(html);
  assert.ok(rows.length > 0, 'fixture has unread rows');
  const { cacheVersion, threadKey } = await import(join(root, 'src', 'shared.ts'));
  const version = cacheVersion(LABELS, 'gateway');
  const seed = {
    provider: 'gateway',
    apiKey: 'e2e-placeholder-key',
    enabled: true,
    threshold: 0.7,
    privacyAck: true,
    labels: LABELS,
    viewInbox: true,
  };
  rows.forEach((row, index) => {
    const key = threadKey({ ...row, legacyThreadId: '', fromName: '', fromEmail: '', subject: '', snippet: '', date: '' }, version);
    seed[`crit:${key}`] = {
      criticalProbability: index === 0 ? 0.95 : 0.1,
      urgencyScore: index === 0 ? 3 : 0,
      labels: {
        visa: index === 0 ? 0.9 : 0.05,
        money: index === 1 || index === 2 ? 0.8 : 0.05,
        home: index === 1 ? 0.8 : 0.05,
      },
      ts: Date.now(),
    };
  });
  await worker.evaluate((items) => chrome.storage.local.set(items), seed);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await context.newCDPSession(page);
  const contentWorld = await isolatedWorld(cdp, extensionId);
  await page.goto(GMAIL_URL);
  await page.waitForSelector('.gc-badge', { timeout: 15000 });
  const badges = await page.locator('.gc-badge').count();
  const chips = await page.locator('.gc-chip').count();
  assert.equal(badges, 1, 'one critical badge from the seeded cache');
  assert.ok(chips >= 1, 'label chips from the seeded cache');
  await page.screenshot({ path: join(outDir, 'gmail-fixture-1440.png') });

  const worldId = await contentWorld();
  const storageRead = await evaluateIn(
    cdp,
    worldId,
    `chrome.storage.local.get(null).then(() => 'read', (error) => 'denied: ' + error.message)`
  );
  assert.match(storageRead, /^denied/, 'content script cannot read storage');

  const testFromTab = await evaluateIn(cdp, worldId, `chrome.runtime.sendMessage({ type: 'test' })`);
  assert.deepEqual(testFromTab, { ok: false, error: 'failed' }, 'test is refused from Gmail');
  const oversized = await evaluateIn(
    cdp,
    worldId,
    `chrome.runtime.sendMessage({ type: 'classify', labels: [], emails: Array.from({ length: 21 }, (_, i) => ({ threadId: 't' + i, legacyThreadId: 'l', lastMessageId: 'm', fromName: '', fromEmail: '', subject: '', snippet: '', date: '' })) })`
  );
  assert.deepEqual(oversized, { ok: false, error: 'failed' }, 'oversized batch is refused');
  const state = await evaluateIn(cdp, worldId, `chrome.runtime.sendMessage({ type: 'state' })`);
  assert.equal(JSON.stringify(state).includes('e2e-placeholder-key'), false, 'state carries no key');

  await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await page.waitForSelector('.gc-badge', { state: 'detached', timeout: 10000 });
  await worker.evaluate(() => chrome.storage.local.set({ enabled: true }));
  await page.waitForSelector('.gc-badge', { timeout: 10000 });

  assert.deepEqual(providerCalls, [], 'no provider call with a warm cache');

  const filtered = await checkFilter(page, worker, rows, tbodyHtml(html), version);
  await shootFilteredGmail(page);
  assert.deepEqual(providerCalls, [], 'no provider call while filtering');

  const popup = await context.newPage();
  async function shootPopup(state) {
    for (const theme of THEMES) {
      await popup.emulateMedia({ colorScheme: theme });
      for (const width of WIDTHS) {
        await popup.setViewportSize({ width, height: 900 });
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await popup.waitForFunction(() => document.getElementById('version')?.textContent !== '');
        await popup.waitForFunction(() => document.getAnimations().length === 0);
        await popup.screenshot({ path: join(outDir, `popup-${state}-${theme}-${width}.png`), fullPage: true });
      }
    }
  }

  await worker.evaluate(() => chrome.storage.local.set({ privacyAck: false }));
  await shootPopup('notice');
  const notice = await popup.locator('#privacyNotice').innerText();
  assert.equal(await popup.locator('#privacyNotice').isVisible(), true, 'first-run notice shows');
  assert.doesNotMatch(notice, /bodies are never sent/i, 'notice does not deny sending body text');
  assert.match(notice, /first part of the (email )?body/i, 'notice says the snippet is body text');
  assert.match(notice, /forwards/i, 'notice says the Gateway forwards to TypeSafe');
  await worker.evaluate(() => chrome.storage.local.set({ privacyAck: true }));
  await shootPopup('ready');
  const searchChecked = await popup.locator('#viewSearch').isChecked();
  assert.equal(searchChecked, false, 'Search is off by default in the popup');
  assert.equal(await popup.locator('#viewInbox').isChecked(), true, 'popup still reads storage');

  console.log(
    JSON.stringify(
      { badges, chips, filtered, storageRead, testFromTab, oversized, providerCalls, searchChecked, outDir },
      null,
      2
    )
  );
} finally {
  await context.close();
}
