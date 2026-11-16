import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManage } from './e2e-manage.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = join(root, 'dist');
const outDir = join(root, 'e2e-results');
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const WIDTHS = [1440, 768, 390, 320];
const THEMES = ['light', 'dark'];
const PROVIDER_HOLD_MS = 400;
const REJECTED_KEY = 'e2e-rejected-key';

const LABELS = [
  { id: 'visa', name: 'Visa', description: 'Residence permits, IND letters, immigration appointments' },
  { id: 'money', name: 'Money', description: 'Invoices, payments, bank statements' },
  { id: 'home', name: 'Home', description: 'Rent, utilities, landlord and building notices' },
  { id: 'school', name: 'School', description: 'Teachers, school trips and report cards' },
];

const AXE_SOURCE = readFileSync(join(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const AXE_BLOCKING = ['serious', 'critical'];

// Injected with evaluate, which the extension pages' CSP does not block. `context` scopes
// the run; null means the whole document.
async function axeCheck(page, context, where) {
  await page.evaluate(AXE_SOURCE);
  const { passes, violations } = await page.evaluate(async (scope) => {
    const result = await window.axe.run(scope ?? document, { resultTypes: ['violations'] });
    const passes = result.passes.map((rule) => rule.id);
    return { passes, violations: result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
    })) };
  }, context);
  assert.ok(passes.includes('button-name') && passes.includes('color-contrast'), `axe checked buttons and contrast in ${where}`);
  const blocking = violations.filter((violation) => AXE_BLOCKING.includes(violation.impact));
  assert.deepEqual(blocking, [], `axe finds no serious or critical violation in ${where}`);
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const violation of violations) counts[violation.impact] += violation.nodes;
  return { counts, passedRules: passes.length, rules: violations.map((violation) => `${violation.id}:${violation.impact}`) };
}

// Our nodes only: the bar and the chip slots. The rest of the fixture is Gmail-like markup.
const GMAIL_AXE_SCOPE = { include: [['#gc-unread'], ['.gc-chips']] };

function fixtureHtml() {
  return readFileSync(join(root, 'dev', 'demo.html'), 'utf8')
    .replace(/<link rel="stylesheet" href="..\/dist\/section.css" \/>/, '')
    .replace(/<script src="..\/(dev-)?dist\/[a-z]+\.js"><\/script>/g, '');
}

function rowsOf(html, rowClass) {
  const rows = [];
  const pattern = new RegExp(
    `<tr class="${rowClass}">[\\s\\S]*?data-thread-id="([^"]+)"[\\s\\S]*?data-legacy-last-message-id="([^"]+)"`,
    'g'
  );
  for (const match of html.matchAll(pattern)) rows.push({ threadId: match[1], lastMessageId: match[2] });
  return rows;
}

function unreadRows(html) {
  return rowsOf(html, 'zA zE');
}

function readRows(html) {
  return rowsOf(html, 'zA yO');
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
      if (target instanceof Element && target.closest('[data-gc-filter], [data-gc-clear], [data-gc-setup]') !== null) {
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

function rowSelector(threadId) {
  return `tr.zA:has([data-thread-id="${threadId}"])`;
}

async function setClassifyRead(worker, value) {
  await worker.evaluate((next) => chrome.storage.local.set({ classifyRead: next }), value);
}

async function readRowsAfterUnread(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.Cp tr.zA')];
    const unread = rows.filter((row) => row.classList.contains('zE'));
    const read = rows.filter((row) => !row.classList.contains('zE'));
    const lastUnread = Math.max(...unread.map((row) => row.getBoundingClientRect().bottom));
    const firstRead = Math.min(...read.map((row) => row.getBoundingClientRect().top));
    return lastUnread <= firstRead + 0.5;
  });
}

async function checkReadRows(page, worker, rows, read) {
  const readMoney = read[0].threadId;
  const readChips = page.locator('tr.zA:not(.zE) span.gc-chips');
  assert.equal(await readChips.count(), 0, 'read rows carry no chips while the toggle is off');

  await setClassifyRead(worker, true);
  const readBadge = page.locator(`${rowSelector(readMoney)} [data-gc-filter="critical"]`);
  await readBadge.waitFor({ state: 'attached', timeout: 10000 });
  await settle(page);
  assert.equal(
    await page.locator(`${rowSelector(readMoney)} [data-gc-filter="label:money"]`).count(),
    1,
    'a read row gets its label chip with the toggle on'
  );
  assert.equal(await readRowsAfterUnread(page), true, 'read rows, even critical ones, stay below unread rows');

  await page.locator('#gc-unread [data-gc-filter="label:money"]').click();
  await settle(page);
  const money = [rows[1].threadId, rows[2].threadId, readMoney].sort();
  assert.deepEqual((await visibleThreads(page)).threads, money, 'the Money filter includes the read Money row');

  await page.evaluate((threadId) => {
    const row = document.querySelector(`tr.zA:has([data-thread-id="${threadId}"])`);
    row.classList.remove('zE');
    row.classList.add('yO');
  }, rows[1].threadId);
  await settle(page);
  assert.deepEqual((await visibleThreads(page)).threads, money, 'a row Gmail marks read stays in the filter');

  await setClassifyRead(worker, false);
  await readChips.first().waitFor({ state: 'detached', timeout: 10000 });
  await settle(page);
  assert.equal(await readChips.count(), 0, 'turning the toggle off removes the read chips');
  assert.deepEqual(await activeFilter(page), [], 'turning the toggle off clears the filter');
  await page.evaluate((threadId) => {
    const row = document.querySelector(`tr.zA:has([data-thread-id="${threadId}"])`);
    row.classList.remove('yO');
    row.classList.add('zE');
  }, rows[1].threadId);
  await page.locator('#gc-unread [data-gc-filter="label:money"]').click();
  await settle(page);
  assert.deepEqual(
    (await visibleThreads(page)).threads,
    [rows[1].threadId, rows[2].threadId].sort(),
    'with the toggle off a cached read classification never matches'
  );
  await page.locator('#gc-unread [data-gc-clear]').click();
  await setClassifyRead(worker, true);
  await readBadge.waitFor({ state: 'attached', timeout: 10000 });
  await settle(page);
  return { money };
}

async function themeReport(page) {
  return page.evaluate(() => {
    const parse = (value) => {
      const text = value.trim();
      const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(text);
      if (srgb !== null) {
        return { r: srgb[1] * 255, g: srgb[2] * 255, b: srgb[3] * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
      }
      const rgb = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:[,/] ?([\d.]+))?\)$/.exec(text);
      if (rgb === null) throw new Error(`unparsed color ${text}`);
      return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const lum = (c) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const background = (el) => {
      const layers = [];
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let node = el; node !== null; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color.a === 0) continue;
        if (color.a >= 1) {
          base = color;
          break;
        }
        layers.push(color);
      }
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const opacity = (el) => {
      let value = 1;
      for (let node = el; node !== null; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
      return value;
    };
    const selector = [
      '#gc-unread .gc-count',
      '#gc-unread .gc-filters-label',
      '#gc-unread .gc-filter',
      '#gc-unread .gc-filter-count',
      '#gc-unread .gc-clear',
      '#gc-unread .gc-setup',
      '#gc-unread .gc-filter-note',
      '.gc-chips .gc-chip',
      '.gc-chips .gc-badge',
    ].join(', ');
    const checked = [];
    for (const el of document.querySelectorAll(selector)) {
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const bg = background(el);
      const fg = parse(getComputedStyle(el).color);
      const value = ratio(over({ ...fg, a: fg.a * opacity(el) }, bg), bg);
      checked.push({ text: el.textContent.trim(), cls: el.className, pressed: el.getAttribute('aria-pressed'), ratio: Math.round(value * 100) / 100 });
    }
    return {
      bar: document.getElementById('gc-unread')?.dataset.gcTheme ?? null,
      slots: [...new Set([...document.querySelectorAll('span.gc-chips')].map((slot) => slot.dataset.gcTheme ?? null))],
      checked: checked.length,
      pressed: checked.filter((item) => item.pressed === 'true').length,
      failing: checked.filter((item) => item.ratio < 4.5),
    };
  });
}

async function assertTheme(page, theme) {
  await page.waitForFunction((expected) => document.getElementById('gc-unread')?.dataset.gcTheme === expected, theme, {
    timeout: 5000,
  });
  const report = await themeReport(page);
  assert.equal(report.bar, theme, `bar follows Gmail's ${theme} theme`);
  assert.deepEqual(report.slots, [theme], `every chip slot follows Gmail's ${theme} theme`);
  assert.ok(report.checked >= 8 && report.pressed >= 2, `measured the bar and pressed chips in ${theme}`);
  assert.deepEqual(report.failing, [], `every bar and chip text reaches AA in ${theme}`);
  return report;
}

async function waitUntil(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function checkReadDispatch(page, worker, read, version, providerCalls) {
  const target = read[read.length - 1];
  const { email, subject } = await page.evaluate((threadId) => {
    const row = document.querySelector(`tr.zA:has([data-thread-id="${threadId}"])`);
    return {
      email: row.querySelector('span[email]').getAttribute('email'),
      subject: row.querySelector('[data-thread-id]').textContent.replace(/\s+/g, ' ').trim(),
    };
  }, target.threadId);
  const sent = () => providerCalls.filter((call) => call.body.includes(email));
  const before = providerCalls.length;

  await setClassifyRead(worker, false);
  await worker.evaluate((key) => chrome.storage.local.remove(key), `crit:${target.threadId}|${target.lastMessageId}|${version}`);
  await page.waitForTimeout(2500);
  assert.equal(providerCalls.length, before, 'an unclassified read row is never sent with the toggle off');

  await setClassifyRead(worker, true);
  await waitUntil(() => sent().length === 1, 'the read row reaches the provider with the toggle on');
  assert.ok(sent()[0].body.includes(subject), 'the request carries the read row subject');
  await setClassifyRead(worker, false);
  await page.waitForTimeout(PROVIDER_HOLD_MS + 3000);
  assert.equal(sent().length, 1, 'switching the toggle off mid-flight sends that read row no more');
  assert.equal(providerCalls.length, before + 1, 'nothing else reaches the provider');
  return { email, requests: sent().length };
}

const SETUP_MESSAGE = 'Open Jev Inbox to finish setup.';

async function checkHalted(page, worker, rows, version, providerCalls) {
  const before = providerCalls.length;
  const cacheKeys = rows.map((row) => `crit:${row.threadId}|${row.lastMessageId}|${version}`);
  await worker.evaluate(
    async ({ keys, apiKey }) => {
      await chrome.storage.local.set({ privacyAck: false, apiKey });
      await chrome.storage.local.remove(keys);
    },
    { keys: cacheKeys, apiKey: REJECTED_KEY }
  );
  for (const theme of THEMES) {
    const url = theme === 'dark' ? GMAIL_URL.replace('#', '?theme=dark#') : GMAIL_URL;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await page.locator('#gc-unread', { hasText: SETUP_MESSAGE }).waitFor({ timeout: 15000 });
    await settle(page);
    assert.equal(await page.locator('.Cp tr.zA', { hasText: 'retrying' }).count(), 0, `no halted row says retrying in ${theme}`);
    assert.equal(await page.locator('.Cp tr.zA .gc-dot').count(), 0, `no halted row shows a loading dot in ${theme}`);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await page.screenshot({ path: join(outDir, `gmail-noack-${theme}-${width}.png`), fullPage: true });
    }
  }
  assert.equal(providerCalls.length, before, 'nothing reaches the provider before the notice is accepted');
  await page.evaluate(() => {
    window.e2eMarkerSeen = false;
    const list = document.querySelector('.Cp');
    new MutationObserver(() => {
      const dot = list.querySelector('tr.zA .gc-dot');
      if (dot !== null) window.e2eDotName = `${dot.getAttribute('role')}:${dot.getAttribute('aria-label')}`;
      if (list.querySelector('tr.zA .gc-dot, tr.zA .gc-pending') !== null) window.e2eMarkerSeen = true;
    }).observe(list, { childList: true, subtree: true });
  });
  await worker.evaluate(() => chrome.storage.local.set({ privacyAck: true }));
  await page.waitForFunction(() => window.e2eMarkerSeen === true, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.e2eDotName), 'img:Classifying', 'the loading dot is named Classifying');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#gc-unread', { hasText: 'The provider rejected the API key.' }).waitFor({ timeout: 15000 });
  await settle(page);
  assert.equal(await page.locator('.Cp tr.zA', { hasText: 'retrying' }).count(), 0, 'no row says retrying after a 401');
  assert.equal(
    await worker.evaluate(() => chrome.storage.local.get('authFailed').then((stored) => stored.authFailed)),
    'gateway',
    'the worker records the rejected provider'
  );
  await page.screenshot({ path: join(outDir, 'gmail-rejected-dark-1440.png'), fullPage: true });
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: 'e2e-placeholder-key' }));
  return { setupMessage: SETUP_MESSAGE, retryingRows: 0, authFailed: 'gateway' };
}

async function shootFilteredGmail(page, firstThread) {
  const themes = {};
  const axe = {};
  for (const theme of THEMES) {
    const url = theme === 'dark' ? GMAIL_URL.replace('#', '?theme=dark#') : GMAIL_URL;
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await page.waitForSelector('#gc-unread [data-gc-filter="label:money"]', { timeout: 15000 });
    await settle(page);
    const critical = rowSelector(firstThread);
    assert.deepEqual(
      await page.locator(`${critical} .gc-chips > *`).evaluateAll((els) => els.map((el) => el.className)),
      ['gc-badge', 'gc-chip gc-hue-0', 'gc-chip gc-hue-3'],
      'the critical row shows Critical next to the hue-3 School chip'
    );
    const [badgeBg, hue3Bg] = await page.evaluate((selector) => {
      const bg = (el) => getComputedStyle(el).backgroundColor;
      return [bg(document.querySelector(`${selector} .gc-badge`)), bg(document.querySelector(`${selector} .gc-hue-3`))];
    }, critical);
    assert.notEqual(badgeBg, hue3Bg, `Critical and the hue-3 chip differ in ${theme}`);
    const live = await page.evaluate(() => {
      const region = document.querySelector('#gc-unread > .gc-live');
      return {
        role: region?.getAttribute('role'),
        politeness: region?.getAttribute('aria-live'),
        count: region?.querySelector('.gc-count') !== null,
        controls: region?.querySelectorAll('button').length,
      };
    });
    assert.deepEqual(live, { role: 'status', politeness: 'polite', count: true, controls: 0 }, 'the bar count is a polite live region without the controls');
    axe[`gmail-${theme}`] = await axeCheck(page, GMAIL_AXE_SCOPE, `the Gmail bar and chips in ${theme}`);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await page.screenshot({ path: join(outDir, `gmail-ready-${theme}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const region = document.querySelector('#gc-unread > .gc-live');
      window.e2eLive = { region, mutations: 0 };
      new MutationObserver((records) => {
        window.e2eLive.mutations += records.length;
      }).observe(region, { childList: true, subtree: true, characterData: true });
    });
    await page.locator('#gc-unread [data-gc-filter="label:money"]').click();
    await settle(page);
    assert.deepEqual(
      await page.evaluate(() => ({
        same: document.querySelector('#gc-unread > .gc-live') === window.e2eLive.region,
        mutations: window.e2eLive.mutations,
      })),
      { same: true, mutations: 0 },
      'a bar re-render with the same count leaves the live region untouched'
    );
    themes[theme] = await assertTheme(page, theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await page.screenshot({ path: join(outDir, `gmail-filtered-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await assertTheme(page, 'light');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await assertTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: null });
  return { themes, axe, liveSwitch: true };
}

const focusedLabel = (popup) =>
  popup.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement ? `${el.getAttribute('aria-label')}=${el.value}` : (el?.id ?? null);
  });

const trashNames = (popup) =>
  popup.locator('.label-card .trash').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));

async function checkLabelsEditor(popup) {
  await popup.setViewportSize({ width: 1440, height: 900 });
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById('version')?.textContent !== '');
  const live = await popup.evaluate(() => ({
    lang: document.documentElement.lang,
    saved: document.getElementById('saved')?.getAttribute('role'),
    test: document.getElementById('testResult')?.getAttribute('role'),
    labelIssue: document.querySelector('.label-card .label-issue')?.getAttribute('role'),
  }));
  assert.deepEqual(live, { lang: 'en', saved: 'status', test: 'status', labelIssue: 'alert' }, 'popup lang and live regions');
  const names = LABELS.map((label) => `Delete label ${label.name}`);
  assert.deepEqual(await trashNames(popup), names, 'each trash button names its label');
  const firstName = popup.locator('.label-card input[type="text"]').first();
  await firstName.fill('Visas');
  assert.equal((await trashNames(popup))[0], 'Delete label Visas', 'the trash name follows the typed name');
  await firstName.fill('Visa');

  await popup.locator('#addLabel').click();
  assert.equal(await focusedLabel(popup), `Label ${LABELS.length + 1} name=`, 'Add label focuses the new name field');
  assert.equal((await trashNames(popup)).at(-1), `Delete unnamed label ${LABELS.length + 1}`, 'an unnamed label has a fallback trash name');

  const trash = (index) => popup.locator('.label-card .trash').nth(index);
  await trash(1).click();
  assert.equal(await trash(1).getAttribute('aria-label'), 'Confirm delete label Money', 'the armed trash names its label');
  assert.equal(
    await popup.locator('.label-card').last().locator('.label-issue').innerText(),
    'Add a name and a description to save this label.',
    'the incomplete label is reported'
  );
  await trash(1).click();
  assert.equal(await focusedLabel(popup), 'Label 2 name=Home', 'deleting a label focuses the next one');

  const last = LABELS.length - 1;
  await trash(last).click();
  await trash(last).click();
  assert.equal(await focusedLabel(popup), `Label ${last} name=School`, 'deleting the last label focuses the previous one');

  while ((await popup.locator('.label-card').count()) > 0) {
    await trash(0).focus();
    await popup.keyboard.press('Enter');
    await popup.keyboard.press('Enter');
  }
  assert.equal(await focusedLabel(popup), 'addLabel', 'deleting the only label focuses Add label');
  await popup.waitForFunction(() => document.getElementById('saved')?.textContent === 'Saved');
  return { trashNames: names, focus: 'next, previous, Add label' };
}

async function contrastOf(page, selector) {
  const { color, backgrounds } = await page.locator(selector).first().evaluate((el) => {
    const backgrounds = [];
    for (let node = el; node !== null; node = node.parentElement) backgrounds.push(getComputedStyle(node).backgroundColor);
    return { color: getComputedStyle(el).color, backgrounds };
  });
  const { contrastRatio, effectiveBackground, parseColor } = await import(join(root, 'src', 'theme.ts'));
  return Math.round(contrastRatio(parseColor(color), effectiveBackground(backgrounds)) * 100) / 100;
}

async function checkBarError(context, worker, rows, version) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const target = rows[rows.length - 1];
  await worker.evaluate((key) => chrome.storage.local.remove(key), `crit:${target.threadId}|${target.lastMessageId}|${version}`);
  await page.goto(GMAIL_URL);
  const error = page.locator('#gc-unread', { hasText: 'The provider refused the request (status 400).' });
  await error.waitFor({ timeout: 15000 });
  const text = await page.locator('#gc-unread').innerText();
  assert.doesNotMatch(text, /e2e: provider calls are refused/, 'the bar never shows the raw provider message');
  assert.doesNotMatch(text, /Classification request failed/, 'the bar maps a 400 to plain text');
  await page.screenshot({ path: join(outDir, 'gmail-error-1440.png') });
  await page.close();
  return text.match(/The provider[^\n]*/)[0];
}

async function labelState(popup) {
  return popup.evaluate(() =>
    [...document.querySelectorAll('#labels .label-card')].map((card) => {
      const fields = [...card.querySelectorAll('input, textarea')];
      const describedBy = fields.map((field) => field.getAttribute('aria-describedby')).find((id) => id !== null);
      return {
        invalid: fields.map((field) => field.getAttribute('aria-invalid')),
        message: describedBy === undefined ? null : document.getElementById(describedBy)?.textContent ?? null,
      };
    })
  );
}

async function storedLabels(worker) {
  return worker.evaluate(() => chrome.storage.local.get('labels').then((stored) => stored.labels));
}

async function openPopup(popup, extensionId) {
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('version')?.textContent !== '');
}

async function makeInvalidLabel(popup) {
  await popup.locator('#addLabel').click();
  const card = popup.locator('#labels .label-card').last();
  await card.locator('input').fill('Travel');
  await popup.locator('#labelCount').click();
  return card;
}

async function checkPopupStates(popup, worker, extensionId) {
  await openPopup(popup, extensionId);
  const headings = await popup.locator('.section h2').allTextContents();
  assert.ok(headings.includes('Strictness') && !headings.includes('Sensitivity'), 'the threshold section reads Strictness');
  assert.equal(await popup.locator('#threshold').getAttribute('aria-label'), 'Strictness', 'the slider is named Strictness');
  const strictHint = await popup.locator('#threshold ~ .hint').innerText();
  assert.match(strictHint, /^Higher shows only/, 'higher means stricter');

  await popup.locator('#testBtn').click();
  await popup.waitForFunction(() => document.getElementById('testBtn')?.textContent === 'Test connection');
  const testText = await popup.locator('#testResult').innerText();
  // The popup opened as a tab is an extension page, so the worker runs the test; the e2e provider answers 400.
  assert.equal(testText, 'The provider refused the request (status 400).', 'the popup maps a provider failure to plain text');
  const testContrast = await contrastOf(popup, '#testResult');

  const card = await makeInvalidLabel(popup);
  let state = await labelState(popup);
  assert.deepEqual(state.at(-1), { invalid: [null, 'true'], message: 'Add a description to save this label.' }, 'the new label flags its description');
  const issueContrast = await contrastOf(popup, '.label-issue:not([hidden])');
  await popup.locator('#labels textarea').first().fill('Residence permits and IND letters');
  await popup.locator('#labelCount').click();
  await popup.waitForTimeout(200);
  let labels = await storedLabels(worker);
  assert.deepEqual(labels.map((label) => label.id), LABELS.map((label) => label.id), 'the invalid label does not block the others');
  assert.equal(labels[0].description, 'Residence permits and IND letters', 'a valid edit saves next to an invalid label');

  await popup.locator('#labels input').nth(1).fill('');
  await popup.locator('#labelCount').click();
  await popup.waitForTimeout(200);
  state = await labelState(popup);
  assert.deepEqual(state[1].invalid, ['true', null], 'emptying a saved name flags it');
  assert.equal((await storedLabels(worker))[1].name, 'Money', 'a saved label keeps its saved version while invalid');
  await popup.locator('#labels input').nth(1).fill('Money');
  assert.deepEqual((await labelState(popup))[1], { invalid: [null, null], message: null }, 'the flag clears as soon as it is fixed');

  await card.locator('textarea').fill('Flights and hotel bookings');
  assert.deepEqual((await labelState(popup)).at(-1), { invalid: [null, null], message: null }, 'fixing the new label clears it');
  await popup.locator('#labelCount').click();
  await popup.waitForTimeout(200);
  labels = await storedLabels(worker);
  assert.equal(labels.length, LABELS.length + 1, 'the fixed label saves');
  assert.deepEqual(labels.slice(0, LABELS.length).map((label) => label.id), LABELS.map((label) => label.id), 'ids never change');
  await worker.evaluate((items) => chrome.storage.local.set({ labels: items }), LABELS);

  await popup.locator('#clear').click();
  assert.equal(await popup.locator('#clear').innerText(), 'Confirm clear', 'the armed Clear cache button says Confirm clear');
  assert.equal(await popup.locator('#clear').getAttribute('aria-label'), 'Confirm clear cache', 'the armed button is named');
  await popup.waitForTimeout(2700);
  assert.equal(await popup.locator('#clear').innerText(), 'Clear cache', 'the button disarms on its own');

  const states = {
    'invalid-label': async () => {
      await makeInvalidLabel(popup);
    },
    error: async () => {
      await popup.locator('#testBtn').click();
      await popup.waitForFunction(() => document.getElementById('testResult')?.textContent !== '');
    },
    'armed-clear': async () => {
      await popup.locator('#clear').click();
      await popup.evaluate(() => window.scrollTo(0, 0));
    },
  };
  const contrast = { testError: { light: testContrast }, labelIssue: { light: issueContrast } };
  for (const theme of THEMES) {
    await popup.emulateMedia({ colorScheme: theme });
    for (const [name, setup] of Object.entries(states)) {
      for (const width of WIDTHS) {
        await popup.setViewportSize({ width, height: 900 });
        await openPopup(popup, extensionId);
        await setup();
        await popup.waitForFunction(() => document.getAnimations().length === 0);
        await popup.screenshot({ path: join(outDir, `popup-${name}-${theme}-${width}.png`), fullPage: true });
      }
    }
    await openPopup(popup, extensionId);
    await makeInvalidLabel(popup);
    contrast.labelIssue[theme] = await contrastOf(popup, '.label-issue:not([hidden])');
    await popup.locator('#testBtn').click();
    await popup.waitForFunction(() => document.getElementById('testResult')?.textContent !== '');
    contrast.testError[theme] = await contrastOf(popup, '#testResult');
  }
  await popup.emulateMedia({ colorScheme: null });
  for (const [name, ratios] of Object.entries(contrast)) {
    for (const [theme, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${name} reaches AA in ${theme} (${ratio})`);
  }
  return { headings, testText, contrast };
}

async function badgeOf(worker) {
  return worker.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}),
    title: await chrome.action.getTitle({}),
  }));
}

async function waitForBadge(worker, text) {
  const deadline = Date.now() + 10000;
  let badge = await badgeOf(worker);
  while (badge.text !== text) {
    if (Date.now() > deadline) throw new Error(`timed out: badge is ${JSON.stringify(badge)}, wanted "${text}"`);
    await new Promise((done) => setTimeout(done, 100));
    badge = await badgeOf(worker);
  }
  return badge;
}

async function waitForTab(context, url, before = []) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const tab = context.pages().find((candidate) => candidate.url() === url && !before.includes(candidate));
    if (tab !== undefined) return tab;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out: no tab at ${url}`);
}

async function shootPopup(page, url, state) {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById('version')?.textContent !== '');
      await page.waitForFunction(() => document.getAnimations().length === 0);
      await page.screenshot({ path: join(outDir, `popup-${state}-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: null });
}

async function checkSetupTab(context, worker, setupUrl) {
  const tab = await waitForTab(context, setupUrl);
  const installBadge = await badgeOf(worker);
  assert.deepEqual(installBadge, { text: '!', title: 'Jev Inbox: finish setup' }, 'a fresh install badges the action');
  await tab.waitForFunction(() => document.getElementById('version')?.textContent !== '');
  const testFromSetup = await tab.evaluate(() => chrome.runtime.sendMessage({ type: 'test' }));
  assert.equal(testFromSetup.error, 'needs_ack', 'test from the setup tab reaches the worker');
  assert.equal(await tab.title(), 'Jev Inbox setup', 'the setup tab has its own title');
  assert.equal(await tab.locator('.welcome h1').innerText(), 'Welcome to Jev Inbox', 'the setup tab welcomes');
  assert.equal(await tab.locator('#privacyNotice').isVisible(), true, 'the setup tab starts on the notice');
  const layout = {};
  for (const width of [1440, 320]) {
    await tab.setViewportSize({ width, height: 900 });
    layout[width] = await tab.evaluate(() => {
      const box = document.body.getBoundingClientRect();
      return { left: Math.round(box.left), width: Math.round(box.width), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(layout[width].overflow, false, `the setup tab does not scroll sideways at ${width}`);
  }
  assert.deepEqual(layout[1440], { left: 530, width: 380, overflow: false }, 'the setup column is centred at 1440');
  assert.deepEqual(layout[320], { left: 0, width: 320, overflow: false }, 'the setup column fills 320');
  await shootPopup(tab, setupUrl, 'setup');
  const axe = {};
  for (const theme of THEMES) {
    await tab.emulateMedia({ colorScheme: theme });
    await tab.setViewportSize({ width: 1440, height: 900 });
    await tab.goto(setupUrl);
    await tab.waitForFunction(() => document.getElementById('version')?.textContent !== '');
    await tab.waitForFunction(() => document.getAnimations().length === 0);
    axe[theme] = await axeCheck(tab, null, `the setup tab in ${theme}`);
  }
  await tab.close();
  return { url: setupUrl, installBadge, testFromSetup: testFromSetup.error, layout, axe };
}

async function checkFinishSetup(context, page, worker, rows, version, setupUrl, providerCalls) {
  const target = rows[rows.length - 1];
  const entry = `crit:${target.threadId}|${target.lastMessageId}|${version}`;
  const saved = await worker.evaluate((key) => chrome.storage.local.get([key, 'apiKey']), entry);
  const before = providerCalls.length;
  await worker.evaluate((key) => chrome.storage.local.remove([key, 'apiKey']), entry);
  const badge = await waitForBadge(worker, '!');
  const button = page.locator('#gc-unread [data-gc-setup]');
  await button.waitFor({ timeout: 10000 });
  assert.equal(await button.evaluate((el) => el.tagName), 'BUTTON', 'Finish setup is a button');
  assert.equal(await button.innerText(), 'Finish setup', 'the halted bar offers Finish setup');
  await watchLeaks(page);
  const open = context.pages();
  await button.focus();
  await page.keyboard.press('Enter');
  const opened = await waitForTab(context, setupUrl, open);
  assert.deepEqual(await leaks(page), [], 'Finish setup never reaches Gmail');
  await opened.close();

  const themes = {};
  for (const theme of THEMES) {
    const url = theme === 'dark' ? GMAIL_URL.replace('#', '?theme=dark#') : GMAIL_URL;
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await page.locator('#gc-unread [data-gc-setup]').waitFor({ timeout: 15000 });
    await page.waitForFunction((expected) => document.getElementById('gc-unread')?.dataset.gcTheme === expected, theme);
    const report = await themeReport(page);
    assert.equal(report.bar, theme, `the halted bar follows Gmail's ${theme} theme`);
    assert.deepEqual(report.failing, [], `the halted bar reaches AA in ${theme}`);
    const setup = await page.evaluate(() => {
      const el = document.querySelector('#gc-unread .gc-setup');
      return { color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor };
    });
    themes[theme] = { checked: report.checked, setup };
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await page.screenshot({ path: join(outDir, `gmail-setup-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  assert.equal(providerCalls.length, before, 'a missing key sends nothing to the provider');
  await worker.evaluate((items) => chrome.storage.local.set(items), saved);
  const done = await waitForBadge(worker, '');
  assert.equal(done.title, 'Jev Inbox', 'the badge clears once a key is back');
  await page.locator('#gc-unread [data-gc-setup]').waitFor({ state: 'detached', timeout: 10000 });
  return { badge, themes };
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

const providerCalls = [];
await context.route(/^https:\/\/(ai-gateway\.vercel\.sh|api\.typesafe\.ai)\//, async (route) => {
  providerCalls.push({ url: route.request().url(), body: route.request().postData() ?? '' });
  const rejected = Object.values(route.request().headers()).some((value) => value.includes(REJECTED_KEY));
  await new Promise((done) => setTimeout(done, PROVIDER_HOLD_MS));
  return route.fulfill({
    status: rejected ? 401 : 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'e2e: provider calls are refused' } }),
  });
});
const html = fixtureHtml();
await context.route('https://mail.google.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: html })
);

try {
  let [worker] = context.serviceWorkers();
  if (worker === undefined) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const setupUrl = `chrome-extension://${extensionId}/popup.html?setup=1`;
  const setupTab = await checkSetupTab(context, worker, setupUrl);

  const rows = unreadRows(html);
  assert.ok(rows.length > 0, 'fixture has unread rows');
  const { cacheVersion, threadKey } = await import(join(root, 'src', 'shared.ts'));
  const version = cacheVersion(LABELS, 'gateway');
  const seed = {
    provider: 'gateway',
    apiKey: 'e2e-placeholder-key',
    apiKeyHint: '-key',
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
        school: index === 0 ? 0.85 : 0.05,
      },
      ts: Date.now(),
    };
  });
  const read = readRows(html);
  assert.ok(read.length >= 2, 'fixture has read rows');
  read.forEach((row, index) => {
    const key = threadKey({ ...row, legacyThreadId: '', fromName: '', fromEmail: '', subject: '', snippet: '', date: '' }, version);
    seed[`crit:${key}`] = {
      criticalProbability: index === 0 ? 0.95 : 0.1,
      urgencyScore: index === 0 ? 3 : 0,
      labels: { visa: 0.05, money: index === 0 ? 0.8 : 0.05, home: 0.05, school: 0.05 },
      ts: Date.now(),
    };
  });
  await worker.evaluate((items) => chrome.storage.local.set(items), seed);
  const readyBadge = await waitForBadge(worker, '');
  assert.equal(readyBadge.title, 'Jev Inbox', 'the badge clears once the notice is accepted and a key is saved');

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
  const readFiltered = await checkReadRows(page, worker, rows, read);
  const theme = await shootFilteredGmail(page, rows[0].threadId);
  assert.deepEqual(providerCalls, [], 'no provider call while filtering');
  const readDispatch = await checkReadDispatch(page, worker, read, version, providerCalls);
  const finishSetup = await checkFinishSetup(context, page, worker, rows, version, setupUrl, providerCalls);
  const halted = await checkHalted(page, worker, rows, version, providerCalls);

  const popup = await context.newPage();

  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.action.default_icon, manifest.icons, 'toolbar icon uses the manifest icons');
  const [, logoWidth, logoHeight] = readFileSync(join(root, 'assets', 'icon.svg'), 'utf8')
    .match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
    .map(Number);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const icons = [];
  for (const [size, path] of Object.entries(manifest.icons)) {
    const icon = await popup.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let left = width;
      let right = -1;
      let top = height;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] < 128) continue;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      const corners = [0, width - 1, (height - 1) * width, height * width - 1].map((i) => data[i * 4 + 3]);
      return { width, height, left, right, top, bottom, corners };
    }, `chrome-extension://${extensionId}/${path}`);
    const size_ = Number(size);
    assert.equal(icon.width, size_, `icon-${size} is ${size} wide`);
    assert.equal(icon.height, size_, `icon-${size} is ${size} tall`);
    assert.deepEqual(icon.corners, [0, 0, 0, 0], `icon-${size} has a transparent canvas`);
    assert.ok(icon.left >= 1 && icon.top >= 1, `icon-${size} is padded`);
    assert.ok(icon.right <= size_ - 2 && icon.bottom <= size_ - 2, `icon-${size} is padded`);
    const boxWidth = icon.right - icon.left + 1;
    const boxHeight = icon.bottom - icon.top + 1;
    const ratio = boxWidth / boxHeight / (logoWidth / logoHeight);
    assert.ok(Math.abs(ratio - 1) < (size_ <= 16 ? 0.25 : 0.1), `icon-${size} keeps the logo's aspect ratio`);
    assert.ok(Math.abs(icon.left - (size_ - 1 - icon.right)) <= 1, `icon-${size} is centred horizontally`);
    assert.ok(Math.abs(icon.top - (size_ - 1 - icon.bottom)) <= 1, `icon-${size} is centred vertically`);
    icons.push({ size: size_, box: `${boxWidth}x${boxHeight}+${icon.left}+${icon.top}` });
  }

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;

  const popupAxe = {};
  async function axePopup(state) {
    for (const theme of THEMES) {
      await popup.emulateMedia({ colorScheme: theme });
      await popup.setViewportSize({ width: 1440, height: 900 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(() => document.getElementById('version')?.textContent !== '');
      await popup.waitForFunction(() => document.getAnimations().length === 0);
      popupAxe[`${state}-${theme}`] = await axeCheck(popup, null, `the ${state} popup in ${theme}`);
    }
  }

  const statusText = () => popup.locator('#statusLine').innerText();
  const statusIs = (text) =>
    popup.waitForFunction((expected) => document.getElementById('statusLine')?.textContent === expected, text, {
      timeout: 10000,
    });

  await worker.evaluate(() => chrome.storage.local.set({ privacyAck: false }));
  await shootPopup(popup, popupUrl, 'notice');
  await axePopup('notice');
  assert.equal(await statusText(), 'Accept the notice below to start', 'status asks for the notice first');
  assert.equal(await popup.locator('#testBtn').isDisabled(), true, 'Test is disabled before the notice');
  const notice = await popup.locator('#privacyNotice').innerText();
  assert.equal(await popup.locator('#privacyNotice').isVisible(), true, 'first-run notice shows');
  assert.doesNotMatch(notice, /bodies are never sent/i, 'notice does not deny sending body text');
  assert.match(notice, /first part of the (email )?body/i, 'notice says the snippet is body text');
  assert.match(notice, /forwards/i, 'notice says the Gateway forwards to TypeSafe');
  assert.match(notice, /read emails/i, 'notice says read emails are sent when the toggle is on');
  const bullets = await popup.locator('#privacyNotice li').allInnerTexts();
  assert.equal(bullets.length, 3, 'the notice is three bullets');
  const disclosures = {
    fields: /sender, subject, snippet and date of unread emails/,
    snippet: /snippet is the first part of the email body; the rest is never sent/,
    gateway: /Vercel AI Gateway key, Vercel forwards each request to TypeSafe/,
    typesafe: /TypeSafe key, it goes to TypeSafe only/,
    labels: /Label names and descriptions are sent too, so keep sensitive information out of them/,
    read: /"Also classify read mail" sends the same fields of read emails/,
    cache: /Results and the sender, subject and date of classified emails are kept in this browser for the Manage page and never sent anywhere/,
  };
  for (const [name, pattern] of Object.entries(disclosures)) {
    assert.match(bullets.join(' ').replace(/\s+/g, ' '), pattern, `the notice discloses ${name}`);
  }
  const repoLinks = await popup.locator('a[href*="github.com"]').evaluateAll((links) => links.map((a) => a.href));
  assert.equal(repoLinks.length, 3, 'popup links the repository and the privacy policy');
  for (const href of repoLinks) {
    assert.ok(href.startsWith('https://github.com/fabolivark/jev-ginbox'), `popup link points to the fork: ${href}`);
  }
  await worker.evaluate(() => chrome.storage.local.set({ privacyAck: true }));
  await shootPopup(popup, popupUrl, 'rejected');
  assert.equal(await statusText(), 'The key was rejected. Replace it below.', 'status says the key was rejected');
  await popup.locator('#apiKeyReplace').click();
  await popup.locator('#apiKey').fill('e2e-placeholder-key');
  await popup.locator('#apiKey').press('Enter');
  await statusIs('Ready. Open Gmail to use it.');
  assert.equal(
    await worker.evaluate(() => chrome.storage.local.get('authFailed').then((stored) => stored.authFailed)),
    undefined,
    'saving a new key clears the rejection'
  );
  await worker.evaluate(() => chrome.storage.local.set({ authFailed: 'gateway' }));
  await statusIs('The key was rejected. Replace it below.');
  await worker.evaluate(() => chrome.storage.local.remove('authFailed'));
  await statusIs('Ready. Open Gmail to use it.');
  await setClassifyRead(worker, true);
  await shootPopup(popup, popupUrl, 'ready');
  await axePopup('ready');
  assert.equal(await statusText(), 'Ready. Open Gmail to use it.', 'status says the active tab is not Gmail');
  assert.equal(await popup.locator('#testBtn').isDisabled(), false, 'Test is enabled with a saved key');
  assert.equal(await popup.locator('#classifyRead').isChecked(), true, 'popup shows the stored read toggle');
  const readHint = await popup.locator('label[for="classifyRead"]').innerText();
  assert.match(readHint, /Also classify read mail/, 'popup names the read toggle');
  assert.match(readHint, /sent/i, 'the read toggle says read rows are sent too');
  await worker.evaluate(() => chrome.storage.local.remove('classifyRead'));
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById('version')?.textContent !== '');
  assert.equal(await popup.locator('#classifyRead').isChecked(), false, 'reading read mail is off by default');
  await popup.locator('label[for="classifyRead"]').click();
  assert.equal(
    await worker.evaluate(() => chrome.storage.local.get('classifyRead').then((stored) => stored.classifyRead)),
    true,
    'the popup switch stores the read toggle'
  );
  const searchChecked = await popup.locator('#viewSearch').isChecked();
  assert.equal(searchChecked, false, 'Search is off by default in the popup');
  assert.equal(await popup.locator('#viewInbox').isChecked(), true, 'popup still reads storage');
  const popupStates = await checkPopupStates(popup, worker, extensionId);
  const barError = await checkBarError(context, worker, rows, version);

  for (const theme of THEMES) {
    await popup.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await popup.setViewportSize({ width, height: 900 });
      await page.bringToFront();
      await popup.goto(popupUrl);
      await statusIs('Active on this Gmail tab');
      await popup.bringToFront();
      await popup.waitForFunction(() => document.getAnimations().length === 0);
      await popup.screenshot({ path: join(outDir, `popup-active-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.close();

  await worker.evaluate(() => chrome.storage.local.remove(['apiKey', 'apiKeyHint']));
  await shootPopup(popup, popupUrl, 'nokey');
  assert.equal(await statusText(), 'Add a key to start', 'status asks for a key');
  assert.equal(await popup.locator('#testBtn').isDisabled(), true, 'Test is disabled with no key');
  assert.equal(await popup.locator('#testHint').innerText(), 'Paste a key above to test it.', 'the hint asks for a key');
  await worker.evaluate(() => {
    self.e2eTestKeys = [];
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'test') return;
      void chrome.storage.local.get('apiKey').then((stored) => self.e2eTestKeys.push(stored.apiKey ?? null));
    });
  });
  await popup.locator('#apiKey').fill('e2e-typed-key');
  assert.equal(await popup.locator('#testBtn').isDisabled(), false, 'a typed key enables Test');
  await popup.locator('#testBtn').click();
  await popup.waitForFunction(() => document.getElementById('testBtn')?.textContent === 'Test connection');
  assert.deepEqual(
    await worker.evaluate(() => self.e2eTestKeys),
    ['e2e-typed-key'],
    'Test saves the typed key before the test message arrives'
  );
  await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await shootPopup(popup, popupUrl, 'paused');
  const dimming = () =>
    popup.evaluate(() => ({
      status: document.getElementById('statusLine').textContent,
      header: Number(getComputedStyle(document.querySelector('.header')).opacity),
      sections: [...document.querySelectorAll('.section, .footer')].map((el) => Number(getComputedStyle(el).opacity)),
    }));
  const paused = await dimming();
  assert.equal(paused.status, 'Paused', 'the paused popup says so');
  assert.equal(paused.header, 1, 'the header stays at full strength when paused');
  assert.ok(paused.sections.length >= 5 && paused.sections.every((value) => value === 0.5), 'paused dims every section');
  await popup.locator('#enabled').click();
  const resumed = await dimming();
  assert.ok(resumed.sections.every((value) => value === 1), 'switching on undims the sections at once');
  await popup.locator('#enabled').click();
  assert.ok((await dimming()).sections.every((value) => value === 0.5), 'switching off dims them again');
  await popup.locator('label[for="viewSearch"]').click();
  assert.equal(await popup.locator('#viewSearch').isChecked(), true, 'dimmed settings stay usable');
  await worker.evaluate(() => chrome.storage.local.set({ enabled: true, viewSearch: false }));
  const labelsEditor = await checkLabelsEditor(popup);

  const gmailMax = Number(readFileSync(join(root, 'src', 'triage.ts'), 'utf8').match(/GMAIL_QUERY_MAX = (\d+)/)[1]);
  const manage = await checkManage({ context, worker, popup, extensionId, outDir, cacheVersion, widths: WIDTHS, themes: THEMES, gmailMax });

  console.log(
    JSON.stringify(
      { setupTab, readyBadge, badges, chips, icons, manage, popupAxe, labelsEditor, filtered, readFiltered, readDispatch, finishSetup, halted, theme, storageRead, testFromTab, oversized, providerCalls: providerCalls.length, searchChecked, popupStates, barError, paused, outDir },
      null,
      2
    )
  );
} finally {
  await context.close();
}
